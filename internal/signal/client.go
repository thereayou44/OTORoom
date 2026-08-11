package signal

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/coder/websocket"
)

type Client struct {
	conn   *websocket.Conn
	buffer chan []byte
	hub    *Hub
	room   string
}

func NewClient(conn *websocket.Conn, hub *Hub) *Client {
	return &Client{
		conn:   conn,
		buffer: make(chan []byte, 32),
		hub:    hub,
	}
}

func (c *Client) read(ctx context.Context, cancel context.CancelFunc) {
	defer cancel()
	defer c.hub.Leave(c)

	for {
		_, data, err := c.conn.Read(ctx)
		if err != nil {
			log.Println("соединение закрыто:", err)
			return
		}

		var msg Message
		if err := json.Unmarshal(data, &msg); err != nil {
			log.Println("не json:", err)
			continue
		}

		switch msg.Type {
		case TypeJoin:
			if c.room != "" {
				continue
			}
			var p joinPayload
			if err := json.Unmarshal(msg.Payload, &p); err != nil {
				c.sendMsg(Message{Type: TypeError, Message: "bad-payload"})
				return
			}
			initiator, err := c.hub.Join(p.Room, c)
			if err != nil {
				c.sendMsg(Message{Type: TypeError, Message: errorCode(err)})
				return
			}
			c.sendMsg(Message{Type: TypeJoined, IsInitiator: initiator})

		case TypeOffer, TypeAnswer, TypeICE:
			if c.room == "" {
				continue
			}
			c.hub.Broadcast(c, data)

		case TypeBye:
			c.hub.Leave(c)
			return
		}
	}
}

func (c *Client) send(msg []byte) {
	select {
	case c.buffer <- msg:
	default:
		fmt.Println("buffer full")
	}
}

func (c *Client) write(ctx context.Context, cancel context.CancelFunc) {
	defer cancel()

	ticker := time.NewTicker(25 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return

		case data := <-c.buffer:
			writeCtx, cancelWrite := context.WithTimeout(ctx, 10*time.Second)
			err := c.conn.Write(writeCtx, websocket.MessageText, data)
			cancelWrite()
			if err != nil {
				return
			}

		case <-ticker.C:
			pingCtx, cancelPing := context.WithTimeout(ctx, 10*time.Second)
			err := c.conn.Ping(pingCtx)
			cancelPing()
			if err != nil {
				return
			}
		}
	}
}

func (c *Client) Serve(parent context.Context) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()

	go c.write(ctx, cancel)
	c.read(ctx, cancel)
}

func (c *Client) sendMsg(msg Message) {
	raw, err := json.Marshal(msg)
	if err != nil {
		log.Println("не удалось сериализовать сообщение:", err)
		return
	}

	c.send(raw)
}
