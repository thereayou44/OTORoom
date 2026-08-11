package config

type Config struct {
	Addr     *string
	TURNURL  *string
	TURNUser *string
	TURNPass *string
	Origins  *[]string
}
