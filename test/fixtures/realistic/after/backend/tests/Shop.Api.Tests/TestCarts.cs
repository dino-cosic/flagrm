using Shop.Api.Models;

namespace Shop.Api.Tests;

internal static class TestCarts
{
    public static readonly Cart Small = new("c-1", [new CartLine("sku-1", 2, 10.005m)]);

    public static readonly Cart Bulk = new("c-2", [new CartLine("sku-2", 10, 5m)]);
}
