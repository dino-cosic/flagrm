using Shop.Api.Models;

namespace Shop.Api.Services;

public interface IPricingEngine
{
    OrderSummary Summarize(Cart cart);
}

public class PricingEngine : IPricingEngine
{
    private const decimal BulkDiscountRate = 0.05m;
    private const int BulkQuantity = 10;

    public OrderSummary Summarize(Cart cart)
    {
        var subtotal = cart.Lines.Sum(l => l.UnitPrice * l.Quantity);
        var discount = cart.Lines.Sum(l => l.Quantity) >= BulkQuantity
            ? Math.Round(subtotal * BulkDiscountRate, 2)
            : 0m;
        return new OrderSummary(subtotal, discount, subtotal - discount);
    }
}
