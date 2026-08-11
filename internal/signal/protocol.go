package signal

import "encoding/json"

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
	Type      string          `json:"type"`
	Initiator string          `json:"initiator"`
	Message   string          `json:"message"`
	Payload   json.RawMessage `json:"payload"`
}
