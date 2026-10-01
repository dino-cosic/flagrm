using Shop.Api.Models;

namespace Shop.Api.Services;

public interface ILegacyPricingCalculator
{
    decimal CalculateTotal(Cart cart);
}

public class LegacyPricingCalculator : ILegacyPricingCalculator
{
    public decimal CalculateTotal(Cart cart)
    {
        decimal total = 0;
        foreach (var line in cart.Lines)
        {
            total += line.UnitPrice * line.Quantity;
        }
        return total;
    }
}
