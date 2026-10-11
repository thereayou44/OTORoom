package runner

import "net/http"

type WandboxRunner struct {
	baseURL   string
	http      *http.Client
	maxOutput int
}
