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

func (r *room) join(client *Client) bool {
	for i, c := range r.clients {
		if c == nil {
			r.clients[i] = client
			return true
		}
	}
	return false
}

func (r *room) leave(client *Client) {
	for i, c := range r.clients {
		if c == client {
			r.clients[i] = nil
		}
	}
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

func (h *Hub) Join(name string, client *Client) (initiator bool, err error) {
	if !roomNameRe.MatchString(name) {
		return false, ErrBadRoom
	}

	h.mu.Lock()

	r, ok := h.rooms[name]
	if !ok {
		r = &room{}
		h.rooms[name] = r
	}

	if r.count() >= 2 {
		h.mu.Unlock()
		return false, ErrRoomFull
	}

	initiator = r.count() > 0

	r.join(client)
	client.room = name

	peers := r.others(client)
	h.mu.Unlock()

	for _, p := range peers {
		p.sendMsg(Message{Type: TypePeerJoined})
	}

	return initiator, nil
}

func (h *Hub) Leave(client *Client) {
	h.mu.Lock()

	name := client.room

	r, ok := h.rooms[name]
	if !ok {
		h.mu.Unlock()
		return
	}

	r.leave(client)
	client.room = ""

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
	if !ok {
		h.mu.Unlock()
		return
	}
	peers := r.others(from)
	h.mu.Unlock()

	for _, p := range peers {
		p.send(raw)
	}
}
