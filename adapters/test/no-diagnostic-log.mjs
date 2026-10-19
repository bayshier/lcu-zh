// Preloaded by `npm test`: keep test runs from writing to the real per-user log directory, and from
// reading or writing the real Pi surface cache (tests that cover it enable it with a temporary home).
process.env.LCU_DIAGNOSTIC_LOG = '0';
process.env.LCU_SURFACE_CACHE = '0';
