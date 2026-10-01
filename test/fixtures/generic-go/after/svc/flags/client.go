package flags

// Client evaluates feature flags.
type Client interface {
	IsEnabled(key string) bool
}

// Static is a Client backed by a fixed map, for tests and local runs.
type Static map[string]bool

func (s Static) IsEnabled(key string) bool { return s[key] }
