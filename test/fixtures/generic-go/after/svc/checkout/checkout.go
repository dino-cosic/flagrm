package checkout

import (
	"fmt"

	"example.com/shop/flags"
)

type Service struct {
	Flags flags.Client
}

func (s *Service) PlaceOrder(total int) string {
	return placeOrderV2(total)
}

func (s *Service) Banner() string {
	return "new"
}

func (s *Service) DarkMode() bool {
	return s.Flags.IsEnabled(flags.DarkMode)
}

func placeOrderV2(total int) string {
	return fmt.Sprintf("v2:%d", total)
}
