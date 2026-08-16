package config

import (
	"os"
	"strings"
)

type Config struct {
	Addr     string
	WebDir   string
	Origins  []string
	TURNURL  string
	TURNUser string
	TURNPass string
}

func Load() Config {
	return Config{
		Addr:     ":" + env("PORT", "8080"),
		WebDir:   env("WEB_DIR", "web"),
		Origins:  splitList(env("ALLOWED_ORIGINS", "")),
		TURNURL:  env("TURN_URL", ""),
		TURNUser: env("TURN_USER", ""),
		TURNPass: env("TURN_PASS", ""),
	}
}

func (c Config) HasTURN() bool {
	return c.TURNURL != "" && c.TURNUser != "" && c.TURNPass != ""
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func splitList(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}
