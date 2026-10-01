package checkout

import (
	"fmt"

	"example.com/shop/flags"
)

type Service struct {
	Flags flags.Client
}

// PlaceOrder uses the new-checkout flow when the flag is on.
func (s *Service) PlaceOrder(total int) string {
	if s.Flags.IsEnabled(flags.NewCheckout) {
		return placeOrderV2(total)
	} else {
		return placeOrderLegacy(total)
	}
}

func (s *Service) Banner() string {
	if !s.Flags.IsEnabled("new-checkout") {
		return "classic"
	}
	return "new"
}

func (s *Service) DarkMode() bool {
	return s.Flags.IsEnabled(flags.DarkMode)
}

func placeOrderV2(total int) string {
	return fmt.Sprintf("v2:%d", total)
}

func placeOrderLegacy(total int) string {
	return fmt.Sprintf("legacy:%d", total)
}
