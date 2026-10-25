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
	// В joined: место в комнате занимала эта же вкладка, и её старое
	// соединение заменено новым (см. Hub.Join).
	Resumed bool            `json:"resumed,omitempty"`
	Message string          `json:"message"`
	Payload json.RawMessage `json:"payload"`
}

type joinPayload struct {
	Room string `json:"room"`
	// Session — идентификатор вкладки. Лежит в sessionStorage, поэтому
	// переживает F5, но у другой вкладки он свой. Пустой — по-старому,
	// без возобновления (так шлёт закэшированный старый фронт).
	Session string `json:"session"`
	// Resume — у вкладки ещё живо RTCPeerConnection: это смена сети, а не
	// перезагрузка, и соединение можно спасти перезапуском ICE.
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
