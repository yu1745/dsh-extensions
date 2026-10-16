export const styles = `
.yu-quota{font:inherit;color:var(--dsw-alias-text-primary,inherit);box-sizing:border-box;width:100%;min-width:0;max-width:none;flex:1;align-self:stretch;margin:0;padding:20px;container-type:inline-size}
.yu-quota *{box-sizing:border-box}
.yu-quota h2{font-size:20px;letter-spacing:-.02em;margin:0;font-weight:650}
.yu-quota h3{font-size:15px;margin:28px 0 10px}
.yu-quota p{line-height:1.55;margin:7px 0}
.yu-muted{opacity:.6;font-size:12px}
.yu-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.yu-quota button,.yu-quota select,.yu-quota input{font:inherit;color:inherit;background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--dsw-alias-border-l3,#dce0e5);border-radius:8px;padding:7px 10px}
.yu-quota button{cursor:pointer}
.yu-quota :focus-visible{outline:2px solid #4c7de0;outline-offset:3px}
.yu-quota button:disabled{opacity:.5;cursor:wait}
.yu-range{display:flex;align-items:center;flex-wrap:wrap;gap:4px;margin:18px 0 14px}
.yu-range>span{font-size:12px;opacity:.6;margin-right:8px}
.yu-range button{border-color:transparent;padding:5px 11px;font-size:12px}
.yu-range button[aria-pressed=true]{background:color-mix(in srgb,currentColor 7%,transparent);font-weight:600}
.yu-providers{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:14px;align-items:start}
.yu-row{min-width:0;border:1px solid var(--dsw-alias-border-l3,#e4e7eb);border-radius:12px;padding:16px}
.yu-row .yu-heading{margin-bottom:12px}
.yu-row .yu-heading>strong{font-size:14px}
.yu-row .yu-heading time{font-size:11px;opacity:.5}
.yu-legend{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px}
.yu-quota .yu-metric{border:0;border-radius:7px;display:flex;flex-direction:column;gap:5px;align-items:flex-start;padding:6px 9px;background:color-mix(in srgb,currentColor 3%,transparent);min-width:76px;transition:opacity .15s}
.yu-metric[aria-pressed=false]{opacity:.35}
.yu-metric-label{display:flex;align-items:center;gap:5px;font-size:11px;opacity:.7}
.yu-metric-label i,.yu-chart-tooltip i{display:inline-block;width:7px;height:7px;border-radius:50%;flex-shrink:0}
.yu-metric strong{font-size:18px;letter-spacing:-.02em;font-weight:600;font-variant-numeric:tabular-nums}
.yu-history{min-width:0;width:100%}
.yu-plot{position:relative;width:100%}
.yu-plot svg{display:block;overflow:visible;touch-action:pan-y}
.yu-chart-tooltip{position:absolute;z-index:2;width:220px;max-width:calc(100% - 8px);pointer-events:none;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-text-primary,inherit);border:1px solid var(--dsw-alias-border-l3,#dce0e5);box-shadow:0 3px 14px #00000012;border-radius:9px;padding:10px 12px;font-size:12px}
.yu-chart-tooltip time{display:block;opacity:.6;margin-bottom:8px;font-size:11px}
.yu-chart-tooltip>div{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:5px}
.yu-chart-tooltip span{display:flex;align-items:center;gap:6px}
.yu-chart-tooltip strong{font-weight:600;font-variant-numeric:tabular-nums}
.yu-chart-caption{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;opacity:.45;font-size:10px;margin-top:4px}
.yu-chart-empty{height:132px;display:grid;place-content:center;font-size:12px;opacity:.55}
.yu-details{font-size:11px;margin-top:12px;padding-top:10px;border-top:1px solid var(--dsw-alias-border-l3,#e4e7eb);opacity:.8}
.yu-details summary{cursor:pointer}
.yu-quota pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;max-height:220px;overflow:auto}
.yu-warning{font-size:12px;color:var(--dsw-alias-text-warning,#a76b20)}
.yu-controls{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:12px}
.yu-controls label{display:grid;gap:6px;font-size:12px}
.yu-controls input,.yu-controls select{min-width:0;width:100%}
.yu-table{border-collapse:collapse;width:100%;font-size:12px;table-layout:auto}
.yu-table td,.yu-table th{padding:10px 6px;text-align:left;border-bottom:1px solid var(--dsw-alias-border-l3,#e4e7eb);overflow-wrap:anywhere}
.yu-table th{font-weight:500;opacity:.6}
.yu-table td{font-variant-numeric:tabular-nums}
.yu-skeleton{height:150px;border-radius:12px;background:var(--dsw-alias-border-l3,#eee);opacity:.5;animation:yu-pulse 1.6s ease-in-out infinite}
@keyframes yu-pulse{50%{opacity:.2}}
@media(prefers-reduced-motion:reduce){.yu-skeleton{animation:none}.yu-metric{transition:none}}
@container(max-width:360px){.yu-row{padding:12px}.yu-quota .yu-metric{min-width:65px;padding:5px 7px}.yu-metric strong{font-size:16px}.yu-chart-caption>span:last-child{display:none}}
`;
