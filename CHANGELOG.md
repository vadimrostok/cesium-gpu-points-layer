# Changelog

## 0.2.0

- Split implementation into dedicated modules: `types`, `shaders`, and `cpu-pipeline`.
- Added new internal/publicly re-exported utilities in pipeline and shader submodules.
- Added unit and integration tests for packing, helpers, shader generation, and layer integration.
- Expanded README with detailed architecture, API, and configuration documentation.

## 0.1.0

- Initial split from demo app into a standalone library.
- Added high-level `GpuPointLayer` export and retained backward-compatible `CesiumGpuPointLayer` alias.
- Added package entry points and TypeScript declaration output.
