package signal

import (
	"errors"
	"regexp"
	"sync"
)

var (
	ErrBadRoom  = errors.New("bad room name")
	ErrRoomFull = errors.New("room is full")
)

type room struct {
	clients [2]*Client
}

type Hub struct {
	rooms map[string]*room
	mu    sync.Mutex
}

func NewHub() *Hub {
	return &Hub{rooms: make(map[string]*room)}
}

var roomNameRe = regexp.MustCompile(`^[a-z0-9-]{2,32}$`)

// Фронт шлёт crypto.randomUUID(). Всё, что на него не похоже, считаем
// отсутствием сессии — работаем по-старому, без возобновления.
var sessionRe = regexp.MustCompile(`^[A-Za-z0-9-]{8,64}$`)

func (r *room) join(client *Client) bool {
	for i, c := range r.clients {
		if c == nil {
			r.clients[i] = client
			return true
		}
	}
	return false
}

// leave убирает клиента и сообщает, был ли он в комнате вообще.
func (r *room) leave(client *Client) bool {
	for i, c := range r.clients {
		if c == client {
			r.clients[i] = nil
			return true
		}
	}
	return false
}

// replace ставит новое соединение на место старого — тот же слот, та же
// вкладка, просто сокет сменился.
func (r *room) replace(old, client *Client) {
	for i, c := range r.clients {
		if c == old {
			r.clients[i] = client
			return
		}
	}
}

func (r *room) has(client *Client) bool {
	for _, c := range r.clients {
		if c == client {
			return true
		}
	}
	return false
}

// bySession находит в комнате соединение той же вкладки.
func (r *room) bySession(session string) *Client {
	if session == "" {
		return nil
	}
	for _, c := range r.clients {
		if c != nil && c.session == session {
			return c
		}
	}
	return nil
}

func (r *room) count() int {
	var cnt int

	for _, c := range r.clients {
		if c != nil {
			cnt++
		}
	}

	return cnt
}

func (r *room) others(except *Client) []*Client {
	var clients []*Client
	for _, c := range r.clients {
		if c != nil && c != except {
			clients = append(clients, c)
		}
	}

	return clients
}

// Join сажает клиента в комнату.
//
// session — идентификатор вкладки (см. joinPayload). Если в комнате уже
// сидит соединение той же вкладки, это не третий участник, а она же:
// сменила сеть или перезагрузилась, а старый сокет сервер ещё не признал
// мёртвым — это заметит только пинг, до ~35 секунд. Раньше вкладка в этот
// момент получала room-full и больше не возвращалась. Теперь старое
// соединение выкидываем, а место отдаём новому. Дальше два случая:
//
//   - resume: у вкладки живо RTCPeerConnection (смена сети). Подменяем
//     сокет тихо, собеседнику ничего не сообщаем: звонок спасает перезапуск
//     ICE, договариваться заново незачем.
//   - не resume: вкладка перезагрузилась, её старое соединение умерло вместе
//     со страницей. Для собеседника она ушла и пришла: он должен разобрать
//     старое RTCPeerConnection и дождаться нового offer'а.
func (h *Hub) Join(name string, client *Client, session string, resume bool) (initiator, resumed bool, err error) {
	if !roomNameRe.MatchString(name) {
		return false, false, ErrBadRoom
	}
	if !sessionRe.MatchString(session) {
		session = ""
	}

	h.mu.Lock()

	r, ok := h.rooms[name]
	if !ok {
		r = &room{}
		h.rooms[name] = r
	}

	stale := r.bySession(session)
	silent := stale != nil && resume

	switch {
	case silent:
		r.replace(stale, client)
	case stale != nil:
		r.leave(stale)
		fallthrough
	default:
		if r.count() >= 2 {
			h.mu.Unlock()
			return false, false, ErrRoomFull
		}
		r.join(client)
	}

	initiator = len(r.others(client)) > 0
	client.room = name
	client.session = session

	peers := r.others(client)
	h.mu.Unlock()

	// Всё ниже — вне лока: рассылка и закрытие сокета строго без мьютекса.
	if stale != nil {
		stale.kick()
	}
	if silent {
		return initiator, true, nil
	}
	for _, p := range peers {
		if stale != nil {
			p.sendMsg(Message{Type: TypePeerLeft})
		}
		p.sendMsg(Message{Type: TypePeerJoined})
	}

	return initiator, stale != nil, nil
}

func (h *Hub) Leave(client *Client) {
	h.mu.Lock()

	name := client.room

	r, ok := h.rooms[name]
	if !ok {
		h.mu.Unlock()
		return
	}

	// Клиента могла заменить его же вкладка (см. Join). Тогда его в комнате
	// уже нет, и сообщать собеседнику нельзя: тот договаривается с новым
	// соединением, и лишний peer-left сломал бы ему свежий звонок.
	removed := r.leave(client)
	client.room = ""
	if !removed {
		h.mu.Unlock()
		return
	}

	if r.count() == 0 {
		delete(h.rooms, name)
	}

	peers := r.others(nil)
	h.mu.Unlock()

	for _, p := range peers {
		p.sendMsg(Message{Type: TypePeerLeft})
	}
}

func (h *Hub) Broadcast(from *Client, raw []byte) {
	h.mu.Lock()
	r, ok := h.rooms[from.room]
	// Заменённый клиент мог ещё дочитать что-то из старого сокета: его
	// кандидаты и offer'ы относятся к мёртвому соединению.
	if !ok || !r.has(from) {
		h.mu.Unlock()
		return
	}
	peers := r.others(from)
	h.mu.Unlock()

	for _, p := range peers {
		p.send(raw)
	}
}
