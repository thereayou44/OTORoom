package signal

import (
	"context"
	"fmt"
	"time"

	"github.com/coder/websocket"
)

type Client struct {
	conn   *websocket.Conn
	buffer chan []byte
}

func NewClient(conn *websocket.Conn) *Client {
	return &Client{
		conn:   conn,
		buffer: make(chan []byte, 32),
	}
}

func (c *Client) read(ctx context.Context, cancel context.CancelFunc) {
	defer cancel()

	for {
		_, message, err := c.conn.Read(ctx)
		if err != nil {
			fmt.Println("read error:", err)
			return
		}

		c.send(message)
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
