using Microsoft.FeatureManagement;
using Shop.Api.Services;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddControllers();
builder.Services.AddFeatureManagement();

builder.Services.AddSingleton<IPricingEngine, PricingEngine>();
builder.Services.AddScoped<CheckoutService>();
builder.Services.AddScoped<OrderSummaryService>();

var app = builder.Build();

app.MapControllers();

app.Run();

public partial class Program;
