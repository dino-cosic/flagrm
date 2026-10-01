using Microsoft.FeatureManagement;

namespace Sample.Api.Services;

public class ApiClientFactory
{
    private readonly IFeatureManager _featureManager;
    private readonly ApiOptions _options;

    public ApiClientFactory(IFeatureManager featureManager, ApiOptions options)
    {
        _featureManager = featureManager;
        _options = options;
    }

    public IApiClient Create()
    {
        var useNewApi = _featureManager.IsEnabledAsync("UseNewApi").Result;
        return useNewApi ? new ApiClientV2(_options) : new LegacyApiClient(_options);
    }

    public string DescribeMode(bool verbose)
    {
        var useNewApi = _featureManager.IsEnabledAsync("UseNewApi").Result;
        if (useNewApi && verbose)
        {
            return "v2 (verbose)";
        }
        return useNewApi ? "v2" : "v1";
    }
}
