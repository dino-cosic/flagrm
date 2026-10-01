using Shop.Api.Models;

namespace Shop.Api.Services;

public class OrderSummaryService(IPricingEngine pricingEngine)
{
    public Task<OrderSummary> SummarizeAsync(Cart cart)
    {
        return Task.FromResult(pricingEngine.Summarize(cart));
    }
}
