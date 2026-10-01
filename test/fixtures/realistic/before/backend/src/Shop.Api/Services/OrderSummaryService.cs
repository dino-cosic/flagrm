using Shop.Api.Features;
using Shop.Api.Models;

namespace Shop.Api.Services;

public class OrderSummaryService(
    ICheckoutFeatures checkoutFeatures,
    IPricingEngine pricingEngine,
    ILegacyPricingCalculator legacyPricing)
{
    public async Task<OrderSummary> SummarizeAsync(Cart cart)
    {
        if (!await checkoutFeatures.IsNewCheckoutEnabledAsync())
        {
            var total = legacyPricing.CalculateTotal(cart);
            return new OrderSummary(total, 0m, total);
        }

        return pricingEngine.Summarize(cart);
    }
}
