package signal

import (
	"encoding/json"
	"errors"
)

const (
	TypeJoin       = "join"
	TypeJoined     = "joined"
	TypeOffer      = "offer"
	TypeAnswer     = "answer"
	TypeICE        = "ice"
	TypeBye        = "bye"
	TypePeerJoined = "peer-joined"
	TypePeerLeft   = "peer-left"
	TypeError      = "error"
)

type Message struct {
	Type        string `json:"type"`
	IsInitiator bool   `json:"initiator,omitempty"`
	// В joined: старое соединение этой же вкладки заменено новым.
	Resumed bool            `json:"resumed,omitempty"`
	Message string          `json:"message"`
	Payload json.RawMessage `json:"payload"`
}

type joinPayload struct {
	Room string `json:"room"`
	// Идентификатор вкладки; пустой — без возобновления (старый фронт).
	Session string `json:"session"`
	// Соединение у вкладки живо: смена сети, а не F5.
	Resume bool `json:"resume"`
}

func errorCode(err error) string {
	switch {
	case errors.Is(err, ErrRoomFull):
		return "room-full"
	case errors.Is(err, ErrBadRoom):
		return "bad-room"
	default:
		return "internal"
	}
}
