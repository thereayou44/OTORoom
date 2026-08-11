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

func (r *room) Join(name string, client Client) (initiator bool, err error) {
	if !roomNameRe.MatchString(name) {
		return false, ErrBadRoom
	}
	//so on.

	return
}
