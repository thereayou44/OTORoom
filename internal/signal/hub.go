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

// Непохожее на UUID считаем отсутствием сессии.
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

func (r *room) leave(client *Client) bool {
	for i, c := range r.clients {
		if c == client {
			r.clients[i] = nil
			return true
		}
	}
	return false
}

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

// Если в комнате уже сидит та же вкладка (session), это не третий участник:
// её старый сокет ещё не признан мёртвым (пинг заметит через ~35 с). Отдаём
// место новому соединению: при resume — тихо, иначе (F5) собеседник получает
// peer-left + peer-joined и пересобирает соединение.
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

	// Заменённый вкладкой клиент (см. Join) уходит молча, иначе peer-left
	// сломал бы собеседнику свежий звонок.
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
	// Заменённый клиент мог дочитать что-то из старого сокета.
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
