using Microsoft.AspNetCore.Mvc;
using Microsoft.FeatureManagement;
using Microsoft.FeatureManagement.Mvc;

namespace Sample.Api.Controllers;

[ApiController]
[Route("api/dashboard")]
public class DashboardController : ControllerBase
{
    private readonly IFeatureManager _featureManager;
    private readonly IDashboardService _dashboardService;

    public DashboardController(IFeatureManager featureManager, IDashboardService dashboardService)
    {
        _featureManager = featureManager;
        _dashboardService = dashboardService;
    }

    [HttpGet]
    public async Task<IActionResult> Get()
    {
        if (await _featureManager.IsEnabledAsync("EnableNewDashboard"))
        {
            var data = await _dashboardService.GetNewDashboardAsync();
            return Ok(data);
        }
        else
        {
            var data = await _dashboardService.GetLegacyDashboardAsync();
            return Ok(data);
        }
    }

    [HttpGet("stats")]
    [FeatureGate("EnableNewDashboard")]
    public IActionResult GetStats()
    {
        return Ok(_dashboardService.GetStats());
    }

    [HttpGet("export")]
    public async Task<IActionResult> Export()
    {
        if (!await _featureManager.IsEnabledAsync("EnableNewDashboard"))
        {
            return NotFound();
        }
        var file = await _dashboardService.ExportAsync();
        return File(file, "text/csv", "dashboard.csv");
    }
}
