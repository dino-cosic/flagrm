using Microsoft.AspNetCore.Mvc;
using Microsoft.FeatureManagement;
using Microsoft.FeatureManagement.Mvc;
using Shop.Api.Features;
using Shop.Api.Models;
using Shop.Api.Services;

namespace Shop.Api.Controllers;

[ApiController]
[Route("api/checkout")]
public class CheckoutController : ControllerBase
{
    private readonly CheckoutService _checkout;
    private readonly OrderSummaryService _summaries;
    private readonly IFeatureManager _featureManager;

    public CheckoutController(CheckoutService checkout, OrderSummaryService summaries, IFeatureManager featureManager)
    {
        _checkout = checkout;
        _summaries = summaries;
        _featureManager = featureManager;
    }

    [HttpPost("orders")]
    public async Task<ActionResult<Order>> PlaceOrder(Cart cart) => Ok(await _checkout.PlaceOrderAsync(cart));

    [HttpPost("summary")]
    public async Task<ActionResult<OrderSummary>> Summary(Cart cart) => Ok(await _summaries.SummarizeAsync(cart));

    [HttpGet("flow")]
    public async Task<ActionResult<string>> Flow()
    {
        var flow = await _featureManager.IsEnabledAsync(nameof(Feature.NewCheckout)) ? "v2" : "v1";
        return Ok(flow);
    }

    [HttpPost("promo")]
    [FeatureGate(FeatureFlags.NewCheckout)]
    public ActionResult<OrderSummary> ApplyPromo(Cart cart, [FromQuery] string code)
    {
        var total = cart.Lines.Sum(l => l.UnitPrice * l.Quantity);
        var discount = code == "WELCOME10" ? Math.Round(total * 0.10m, 2) : 0m;
        return Ok(new OrderSummary(total, discount, total - discount));
    }
}
