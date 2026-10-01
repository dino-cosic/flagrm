namespace Shop.Api.Models;

public record CartLine(string Sku, int Quantity, decimal UnitPrice);

public record Cart(string CustomerId, IReadOnlyList<CartLine> Lines);

public record Order(string Id, decimal Total, string Flow);

public record OrderSummary(decimal Subtotal, decimal Discount, decimal Total);
