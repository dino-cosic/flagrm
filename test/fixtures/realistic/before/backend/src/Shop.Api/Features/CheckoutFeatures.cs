using Microsoft.FeatureManagement;

namespace Shop.Api.Features;

public interface ICheckoutFeatures
{
    Task<bool> IsNewCheckoutEnabledAsync();
}

public class CheckoutFeatures : ICheckoutFeatures
{
    private readonly IFeatureManager _featureManager;

    public CheckoutFeatures(IFeatureManager featureManager)
    {
        _featureManager = featureManager;
    }

    public Task<bool> IsNewCheckoutEnabledAsync() => _featureManager.IsEnabledAsync(FeatureFlags.NewCheckout);
}
