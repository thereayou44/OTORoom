package signal

import (
	"encoding/json"
	"sync"
	"testing"
)

// Клиент без сокета: для проверки Hub достаточно канала, сеть не нужна.
func fakeClient() *Client {
	return &Client{buffer: make(chan []byte, 32)}
}

// recvType достаёт тип следующего сообщения из канала, "" если пусто.
func recvType(t *testing.T, c *Client) string {
	t.Helper()
	select {
	case raw := <-c.buffer:
		var m Message
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatalf("в канале не json: %v", err)
		}
		return m.Type
	default:
		return ""
	}
}

func mustJoin(t *testing.T, h *Hub, room string, c *Client) {
	t.Helper()
	if _, _, err := h.Join(room, c, "", false); err != nil {
		t.Fatalf("Join(%q) упал: %v", room, err)
	}
}

func TestJoin_Initiator(t *testing.T) {
	h := NewHub()
	a, b := fakeClient(), fakeClient()

	if init, _, err := h.Join("algo-1", a, "", false); err != nil || init {
		t.Fatalf("первый: initiator=%v err=%v, хочу false/nil", init, err)
	}
	if init, _, err := h.Join("algo-1", b, "", false); err != nil || !init {
		t.Fatalf("второй: initiator=%v err=%v, хочу true/nil", init, err)
	}
	if got := recvType(t, a); got != TypePeerJoined {
		t.Fatalf("первый должен получить peer-joined, получил %q", got)
	}
}

func TestJoin_RoomFull(t *testing.T) {
	h := NewHub()
	a, b, c := fakeClient(), fakeClient(), fakeClient()

	mustJoin(t, h, "algo-1", a)
	mustJoin(t, h, "algo-1", b)

	if _, _, err := h.Join("algo-1", c, "", false); err != ErrRoomFull {
		t.Fatalf("третий должен получить ErrRoomFull, получил %v", err)
	}
	if a.room != "algo-1" || b.room != "algo-1" {
		t.Fatal("первые двое должны остаться в комнате")
	}
}

func TestJoin_BadName(t *testing.T) {
	h := NewHub()
	for _, name := range []string{"A", "x", "имя", "with space", ""} {
		if _, _, err := h.Join(name, fakeClient(), "", false); err != ErrBadRoom {
			t.Fatalf("имя %q: хочу ErrBadRoom, получил %v", name, err)
		}
	}
}

func TestLeave_RoomDeleted(t *testing.T) {
	h := NewHub()
	a, b := fakeClient(), fakeClient()

	mustJoin(t, h, "algo-1", a)
	mustJoin(t, h, "algo-1", b)

	h.Leave(a)
	if got := recvType(t, b); got != TypePeerLeft {
		t.Fatalf("оставшийся должен получить peer-left, получил %q", got)
	}

	h.Leave(b)

	h.mu.Lock()
	n := len(h.rooms)
	h.mu.Unlock()
	if n != 0 {
		t.Fatalf("после ухода обоих комнат должно быть 0, осталось %d", n)
	}
}

func TestLeave_Idempotent(t *testing.T) {
	h := NewHub()
	a := fakeClient()

	h.Leave(a) // никогда не заходил
	mustJoin(t, h, "algo-1", a)
	h.Leave(a)
	h.Leave(a) // повторно
}

// Слот должен освобождаться: после ухода одного второй может войти.
func TestLeave_FreesSlot(t *testing.T) {
	h := NewHub()
	a, b, c := fakeClient(), fakeClient(), fakeClient()

	mustJoin(t, h, "algo-1", a)
	mustJoin(t, h, "algo-1", b)
	h.Leave(a)

	if _, _, err := h.Join("algo-1", c, "", false); err != nil {
		t.Fatalf("после ухода одного слот должен освободиться, получил %v", err)
	}
}

func TestBroadcast(t *testing.T) {
	h := NewHub()
	a, b := fakeClient(), fakeClient()

	mustJoin(t, h, "algo-1", a)
	mustJoin(t, h, "algo-1", b)
	recvType(t, a) // вычитываем peer-joined, иначе он помешает проверке ниже

	h.Broadcast(a, []byte(`{"type":"offer","payload":{"x":1}}`))

	if got := recvType(t, b); got != TypeOffer {
		t.Fatalf("второй должен получить offer, получил %q", got)
	}
	if got := recvType(t, a); got != "" {
		t.Fatalf("отправитель не должен получать своё сообщение, получил %q", got)
	}
}

// Сообщения из одной комнаты не должны попадать в другую.
func TestBroadcast_RoomIsolation(t *testing.T) {
	h := NewHub()
	a, b := fakeClient(), fakeClient()

	mustJoin(t, h, "room-one", a)
	mustJoin(t, h, "room-two", b)

	h.Broadcast(a, []byte(`{"type":"offer"}`))

	if got := recvType(t, b); got != "" {
		t.Fatalf("клиент из другой комнаты не должен ничего получить, получил %q", got)
	}
}

// Гоняется с -race: ловит гонки, которые руками не воспроизвести.
func TestConcurrent(t *testing.T) {
	h := NewHub()
	var wg sync.WaitGroup

	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c := fakeClient()
			if _, _, err := h.Join("algo-1", c, "", false); err == nil {
				h.Broadcast(c, []byte(`{"type":"ice"}`))
			}
			h.Leave(c)
		}()
	}
	wg.Wait()

	h.mu.Lock()
	n := len(h.rooms)
	h.mu.Unlock()
	if n != 0 {
		t.Fatalf("после ухода всех комнат должно быть 0, осталось %d", n)
	}
}

// Сессии в формате фронта — crypto.randomUUID().
const (
	tabA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa"
	tabB = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb"
	tabC = "cccccccc-3333-4333-8333-cccccccccccc"
)

// twoInRoom сажает A и B и вычищает peer-joined у A.
func twoInRoom(t *testing.T, h *Hub) (a, b *Client) {
	t.Helper()
	a, b = fakeClient(), fakeClient()
	if _, _, err := h.Join("algo-1", a, tabA, false); err != nil {
		t.Fatal(err)
	}
	if _, _, err := h.Join("algo-1", b, tabB, false); err != nil {
		t.Fatal(err)
	}
	if got := recvType(t, a); got != TypePeerJoined {
		t.Fatalf("A должен был получить peer-joined, получил %q", got)
	}
	return a, b
}

func TestJoin_ReloadedTabTakesGhostsPlace(t *testing.T) {
	// A перезагрузился, старый сокет сервер ещё считает живым.
	h := NewHub()
	_, b := twoInRoom(t, h)

	a2 := fakeClient()
	init, resumed, err := h.Join("algo-1", a2, tabA, false)
	if err != nil {
		t.Fatalf("та же вкладка не должна получать room-full: %v", err)
	}
	if !resumed || !init {
		t.Fatalf("resumed=%v initiator=%v: вернувшаяся вкладка начинает переговоры заново", resumed, init)
	}

	// Порядок важен: B разбирает мёртвое соединение, потом ждёт offer.
	if got := recvType(t, b); got != TypePeerLeft {
		t.Fatalf("B первым должен получить peer-left, получил %q", got)
	}
	if got := recvType(t, b); got != TypePeerJoined {
		t.Fatalf("B следом должен получить peer-joined, получил %q", got)
	}
}

func TestJoin_ResumeAfterNetworkChangeIsSilent(t *testing.T) {
	h := NewHub()
	_, b := twoInRoom(t, h)

	if _, resumed, err := h.Join("algo-1", fakeClient(), tabA, true); err != nil || !resumed {
		t.Fatalf("resumed=%v err=%v", resumed, err)
	}
	if got := recvType(t, b); got != "" {
		t.Fatalf("при тихой замене B не должен ничего получать, получил %q", got)
	}
}

func TestJoin_OtherTabStillGetsRoomFull(t *testing.T) {
	h := NewHub()
	twoInRoom(t, h)

	if _, _, err := h.Join("algo-1", fakeClient(), tabC, false); err != ErrRoomFull {
		t.Fatalf("третья вкладка должна получить ErrRoomFull, получила %v", err)
	}
}

func TestJoin_EmptyOrGarbageSessionNeverMatches(t *testing.T) {
	for _, s := range []string{"", "short", "имя-кириллицей", "with spaces here"} {
		h := NewHub()
		if _, _, err := h.Join("algo-1", fakeClient(), s, false); err != nil {
			t.Fatal(err)
		}
		if _, _, err := h.Join("algo-1", fakeClient(), s, false); err != nil {
			t.Fatal(err)
		}
		if _, _, err := h.Join("algo-1", fakeClient(), s, true); err != ErrRoomFull {
			t.Fatalf("сессия %q: ждали ErrRoomFull, получили %v", s, err)
		}
	}
}

func TestLeave_GhostLeavingDoesNotDisturbPeer(t *testing.T) {
	// Старый сокет A умирает позже, когда B уже договаривается с новым A.
	h := NewHub()
	a, b := twoInRoom(t, h)
	a2 := fakeClient()
	if _, _, err := h.Join("algo-1", a2, tabA, true); err != nil {
		t.Fatal(err)
	}

	h.Leave(a)

	if got := recvType(t, b); got != "" {
		t.Fatalf("уход призрака не должен доходить до B, получил %q", got)
	}
	if _, _, err := h.Join("algo-1", fakeClient(), tabC, false); err != ErrRoomFull {
		t.Fatalf("Leave призрака освободил чужое место: %v", err)
	}
}

func TestBroadcast_GhostIsMuted(t *testing.T) {
	h := NewHub()
	a, b := twoInRoom(t, h)
	a2 := fakeClient()
	if _, _, err := h.Join("algo-1", a2, tabA, true); err != nil {
		t.Fatal(err)
	}

	h.Broadcast(a, []byte(`{"type":"ice"}`))
	if got := recvType(t, b); got != "" {
		t.Fatalf("сообщение призрака дошло до B: %q", got)
	}

	h.Broadcast(a2, []byte(`{"type":"ice"}`))
	if got := recvType(t, b); got != TypeICE {
		t.Fatalf("сообщение нового соединения не дошло: %q", got)
	}
}
