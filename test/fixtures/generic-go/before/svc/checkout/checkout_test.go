package checkout

import (
	"testing"

	"example.com/shop/flags"
)

func TestPlaceOrderNewCheckout(t *testing.T) {
	s := &Service{Flags: flags.Static{flags.NewCheckout: true}}
	if got := s.PlaceOrder(5); got != "v2:5" {
		t.Fatalf("PlaceOrder = %q", got)
	}
}

func TestPlaceOrderLegacy(t *testing.T) {
	s := &Service{Flags: flags.Static{flags.NewCheckout: false}}
	if got := s.PlaceOrder(5); got != "legacy:5" {
		t.Fatalf("PlaceOrder = %q", got)
	}
}

func TestDarkMode(t *testing.T) {
	s := &Service{Flags: flags.Static{flags.DarkMode: true}}
	if !s.DarkMode() {
		t.Fatal("DarkMode = false")
	}
}
