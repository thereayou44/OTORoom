package signal

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"runtime/debug"
	"time"

	"github.com/coder/websocket"
)

type Client struct {
	conn   *websocket.Conn
	buffer chan []byte
	hub    *Hub
	room   string
	// Идентификатор вкладки. Пишется и читается только под Hub.mu.
	session string
}

func NewClient(conn *websocket.Conn, hub *Hub) *Client {
	return &Client{
		conn:   conn,
		buffer: make(chan []byte, 32),
		hub:    hub,
	}
}

// kick обрывает соединение, которое заменила его же вкладка (Hub.Join).
// Сокет там, скорее всего, и так мёртвый — сеть сменилась, — но ждать, пока
// это заметит пинг, незачем. CloseNow безопасно звать из чужой горутины;
// после него read выйдет и отработает defer Leave, а тот ничего не сделает:
// в комнате этого клиента уже нет. В тестах хаба сокета нет вовсе.
func (c *Client) kick() {
	if c.conn != nil {
		_ = c.conn.CloseNow()
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
			initiator, resumed, err := c.hub.Join(p.Room, c, p.Session, p.Resume)
			if err != nil {
				c.sendMsg(Message{Type: TypeError, Message: errorCode(err)})
				return
			}
			c.sendMsg(Message{Type: TypeJoined, IsInitiator: initiator, Resumed: resumed})

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

	// write — отдельная горутина, и панику в ней net/http не ловит: без этого
	// recover она роняет весь процесс со всеми комнатами. Перехватываем,
	// пишем стек и выходим. Убирать за собой отдельно не нужно: defer cancel()
	// выше выполнится после recover, read выйдет из Read, а его
	// defer c.hub.Leave(c) освободит место в комнате — иначе полуживой клиент
	// навсегда занял бы слот, и в комнату больше никто бы не вошёл.
	defer func() {
		if r := recover(); r != nil {
			log.Printf("паника в write, клиент отключён: %v\n%s", r, debug.Stack())
		}
	}()

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
