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
	if _, err := h.Join(room, c); err != nil {
		t.Fatalf("Join(%q) упал: %v", room, err)
	}
}

func TestJoin_Initiator(t *testing.T) {
	h := NewHub()
	a, b := fakeClient(), fakeClient()

	if init, err := h.Join("algo-1", a); err != nil || init {
		t.Fatalf("первый: initiator=%v err=%v, хочу false/nil", init, err)
	}
	if init, err := h.Join("algo-1", b); err != nil || !init {
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

	if _, err := h.Join("algo-1", c); err != ErrRoomFull {
		t.Fatalf("третий должен получить ErrRoomFull, получил %v", err)
	}
	if a.room != "algo-1" || b.room != "algo-1" {
		t.Fatal("первые двое должны остаться в комнате")
	}
}

func TestJoin_BadName(t *testing.T) {
	h := NewHub()
	for _, name := range []string{"A", "x", "имя", "with space", ""} {
		if _, err := h.Join(name, fakeClient()); err != ErrBadRoom {
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

	if _, err := h.Join("algo-1", c); err != nil {
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
			if _, err := h.Join("algo-1", c); err == nil {
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
