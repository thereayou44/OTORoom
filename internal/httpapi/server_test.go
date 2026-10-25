package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/thereayou44/OTORoom.git/internal/config"
	"github.com/thereayou44/OTORoom.git/internal/signal"
)

func do(t *testing.T, cfg config.Config, path string) *httptest.ResponseRecorder {
	t.Helper()
	// Статика и запуск кода этим тестам не нужны — пустой ФС в памяти и
	// фейковый раннер из run_test.go.
	s := New(cfg, signal.NewHub(), fstest.MapFS{}, &fakeRunner{})
	rec := httptest.NewRecorder()
	s.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func TestICE_WithoutTURN(t *testing.T) {
	rec := do(t, config.Config{}, "/api/ice")

	var body struct {
		ICEServers []struct {
			URLs       string `json:"urls"`
			Username   string `json:"username"`
			Credential string `json:"credential"`
		} `json:"iceServers"`
	}
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("ответ не json: %v", err)
	}
	if len(body.ICEServers) != 1 {
		t.Fatalf("без TURN должен быть только STUN, получил %d", len(body.ICEServers))
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control должен быть no-store, получил %q", got)
	}
}

func TestICE_WithTURN(t *testing.T) {
	cfg := config.Config{
		TURNURL:  "turn:relay.example:80",
		TURNUser: "user",
		TURNPass: "pass",
	}
	rec := do(t, cfg, "/api/ice")

	var body struct {
		ICEServers []struct {
			URLs       string `json:"urls"`
			Username   string `json:"username"`
			Credential string `json:"credential"`
		} `json:"iceServers"`
	}
	_ = json.NewDecoder(rec.Body).Decode(&body)

	if len(body.ICEServers) != 2 {
		t.Fatalf("с TURN должно быть 2 сервера, получил %d", len(body.ICEServers))
	}
	turn := body.ICEServers[1]
	if turn.Username != "user" || turn.Credential != "pass" {
		t.Fatalf("креды TURN не проброшены: %+v", turn)
	}
}

func TestHealthz(t *testing.T) {
	rec := do(t, config.Config{}, "/healthz")
	if rec.Code != http.StatusOK || rec.Body.String() != "OK" {
		t.Fatalf("healthz: код %d, тело %q", rec.Code, rec.Body.String())
	}
}

func TestRecoverer_PanicBecomes500(t *testing.T) {
	h := recoverer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		var m map[string]int
		m["boom"] = 1 // запись в nil-карту — настоящая паника рантайма
	}))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/x", nil))

	if rec.Code != http.StatusInternalServerError {
		t.Fatalf("паника должна превращаться в 500, получили %d", rec.Code)
	}
}

func TestRecoverer_PassesThroughAbortHandler(t *testing.T) {
	h := recoverer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic(http.ErrAbortHandler)
	}))

	defer func() {
		if r := recover(); r != http.ErrAbortHandler {
			t.Fatalf("ErrAbortHandler должен пробрасываться дальше, получили %v", r)
		}
	}()
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "/x", nil))
	t.Fatal("сюда дойти не должны: ErrAbortHandler проглочен")
}
