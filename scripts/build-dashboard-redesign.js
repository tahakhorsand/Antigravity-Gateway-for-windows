import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const targetPath = path.resolve(__dirname, '../src/dashboard.html');

const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Antigravity Gateway &bull; Console</title>
  <script src="https://unpkg.com/lucide@latest"></script>
  <style>
    :root {
      --bg: #000000;
      --surface-1: #0a0a0a;
      --surface-2: #111111;
      --surface-3: #171717;
      --surface-hover: #1f1f1f;
      --border-subtle: #1e1e1e;
      --border-muted: #2a2a2a;
      --border-hover: #3d3d3d;
      --text-1: #f5f5f5;
      --text-2: #a1a1aa;
      --text-3: #71717a;
      --text-4: #52525b;
      --accent: #ffffff;
      --accent-invert: #000000;
      --green: #10b981;
      --green-subtle: rgba(16, 185, 129, 0.08);
      --green-border: rgba(16, 185, 129, 0.25);
      --amber: #f59e0b;
      --amber-subtle: rgba(245, 158, 11, 0.08);
      --amber-border: rgba(245, 158, 11, 0.25);
      --red: #ef4444;
      --red-subtle: rgba(239, 68, 68, 0.08);
      --red-border: rgba(239, 68, 68, 0.25);
      --blue: #3b82f6;
      --blue-subtle: rgba(59, 130, 246, 0.08);
      --blue-border: rgba(59, 130, 246, 0.25);
      --purple: #a855f7;
      --radius-sm: 4px;
      --radius-md: 6px;
      --radius-lg: 8px;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Geist", "Inter", sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, "Geist Mono", Menlo, Monaco, Consolas, monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: var(--font-sans);
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }

    body {
      background-color: var(--bg);
      color: var(--text-1);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      font-size: 13px;
      line-height: 1.5;
    }

    /* macOS Window Drag Handle */
    .titlebar {
      height: 32px;
      -webkit-app-region: drag;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 500;
      color: var(--text-4);
      border-bottom: 1px solid var(--border-subtle);
      background: #000;
      user-select: none;
      letter-spacing: 0.2px;
    }

    .container {
      max-width: 1440px;
      margin: 0 auto;
      padding: 24px 32px 64px;
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    /* Top Navigation Header */
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
      padding-bottom: 4px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .brand-icon {
      width: 32px;
      height: 32px;
      border-radius: var(--radius-md);
      background: #111;
      border: 1px solid var(--border-muted);
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
    }

    .brand-text {
      display: flex;
      flex-direction: column;
    }

    .brand-title-wrap {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .brand-title {
      font-size: 15px;
      font-weight: 600;
      letter-spacing: -0.2px;
      color: var(--text-1);
    }

    .badge-tag {
      font-size: 10px;
      font-family: var(--font-mono);
      padding: 1px 5px;
      border-radius: 4px;
      background: var(--surface-2);
      border: 1px solid var(--border-subtle);
      color: var(--text-3);
    }

    .brand-meta {
      font-size: 11px;
      color: var(--text-3);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .pulse-dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--green);
      display: inline-block;
      box-shadow: 0 0 6px rgba(16, 185, 129, 0.4);
    }

    .header-right {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
    }

    /* Pills & Metric Badges */
    .telemetry-pill {
      height: 30px;
      padding: 0 10px;
      border-radius: var(--radius-md);
      background: var(--surface-1);
      border: 1px solid var(--border-subtle);
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-size: 11px;
      color: var(--text-2);
      white-space: nowrap;
    }

    .telemetry-pill.interactive {
      cursor: pointer;
      transition: all 0.15s ease;
    }

    .telemetry-pill.interactive:hover {
      border-color: var(--border-muted);
      color: var(--text-1);
      background: var(--surface-2);
    }

    .telemetry-pill strong {
      color: var(--text-1);
      font-weight: 500;
    }

    /* Vercel Style Buttons */
    .btn {
      height: 30px;
      padding: 0 11px;
      border-radius: var(--radius-md);
      font-size: 12px;
      font-weight: 500;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.15s ease;
      text-decoration: none;
      white-space: nowrap;
      user-select: none;
    }

    .btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    .btn-primary {
      background: var(--accent);
      color: var(--accent-invert);
    }

    .btn-primary:hover:not(:disabled) {
      background: #e4e4e7;
    }

    .btn-secondary {
      background: var(--surface-2);
      border-color: var(--border-muted);
      color: var(--text-1);
    }

    .btn-secondary:hover:not(:disabled) {
      background: var(--surface-hover);
      border-color: var(--border-hover);
    }

    .btn-ghost {
      background: transparent;
      color: var(--text-2);
    }

    .btn-ghost:hover:not(:disabled) {
      background: var(--surface-2);
      color: var(--text-1);
    }

    .btn-sm {
      height: 26px;
      padding: 0 8px;
      font-size: 11px;
    }

    .btn-icon {
      width: 30px;
      padding: 0;
    }

    .btn-icon-sm {
      width: 26px;
      padding: 0;
    }

    /* Keyboard Shortcut Tag */
    kbd {
      font-family: var(--font-mono);
      font-size: 10px;
      padding: 1px 4px;
      border-radius: 3px;
      background: #18181b;
      border: 1px solid #333;
      color: var(--text-3);
      line-height: 1;
    }

    /* Vercel Segmented Nav Tabs */
    .nav-tabs-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border-subtle);
      margin-top: 4px;
      position: sticky;
      top: 0;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(12px);
      z-index: 20;
    }

    .nav-tabs {
      display: flex;
      gap: 2px;
    }

    .nav-tab {
      padding: 10px 14px;
      font-size: 12px;
      font-weight: 500;
      color: var(--text-3);
      border: none;
      background: transparent;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      position: relative;
      transition: color 0.15s ease;
    }

    .nav-tab:hover {
      color: var(--text-2);
    }

    .nav-tab.active {
      color: var(--text-1);
    }

    .nav-tab.active::after {
      content: '';
      position: absolute;
      bottom: -1px;
      left: 0;
      right: 0;
      height: 2px;
      background: var(--accent);
    }

    .nav-tab-badge {
      font-size: 10px;
      font-family: var(--font-mono);
      padding: 1px 5px;
      border-radius: 9999px;
      background: var(--surface-2);
      border: 1px solid var(--border-subtle);
      color: var(--text-3);
    }

    .nav-tab.active .nav-tab-badge {
      background: var(--surface-3);
      color: var(--text-2);
      border-color: var(--border-muted);
    }

    .nav-right-meta {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 11px;
      color: var(--text-3);
    }

    /* Tab Panes */
    .tab-pane {
      display: none;
      flex-direction: column;
      gap: 16px;
    }

    .tab-pane.active {
      display: flex;
    }

    /* Precision Status Badges */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 7px;
      border-radius: 9999px;
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
      border: 1px solid transparent;
      font-variant-numeric: tabular-nums;
    }

    .status-badge.active-now {
      background: var(--green-subtle);
      border-color: var(--green-border);
      color: var(--green);
    }

    .status-badge.generating {
      background: var(--blue-subtle);
      border-color: var(--blue-border);
      color: var(--blue);
    }

    .status-badge.queued {
      background: var(--amber-subtle);
      border-color: var(--amber-border);
      color: var(--amber);
    }

    .status-badge.cooling {
      background: var(--amber-subtle);
      border-color: var(--amber-border);
      color: var(--amber);
    }

    .status-badge.restricted {
      background: var(--red-subtle);
      border-color: var(--red-border);
      color: var(--red);
    }

    .status-badge.standby {
      background: var(--surface-2);
      border-color: var(--border-subtle);
      color: var(--text-3);
    }

    /* Cards / Surfaces */
    .card {
      background: var(--surface-1);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 16px 20px;
      transition: border-color 0.15s ease;
    }

    .card:hover {
      border-color: var(--border-muted);
    }

    /* View Switcher Header */
    .view-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }

    .section-heading {
      font-size: 13px;
      font-weight: 600;
      color: var(--text-1);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .section-sub {
      font-size: 12px;
      color: var(--text-3);
      font-weight: normal;
    }

    .segmented-control {
      display: flex;
      background: var(--surface-2);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 2px;
      gap: 2px;
    }

    .segmented-btn {
      padding: 4px 10px;
      border: none;
      background: transparent;
      color: var(--text-3);
      font-size: 11px;
      font-weight: 500;
      border-radius: 4px;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 5px;
      transition: all 0.15s ease;
    }

    .segmented-btn:hover {
      color: var(--text-2);
    }

    .segmented-btn.active {
      background: var(--surface-hover);
      color: var(--text-1);
      border: 1px solid var(--border-muted);
    }

    /* High-Density Data Table (Vercel Style) */
    .table-container {
      background: var(--surface-1);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      overflow-x: auto;
    }

    .data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
      text-align: left;
    }

    .data-table th {
      padding: 10px 14px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-3);
      border-bottom: 1px solid var(--border-subtle);
      background: #0d0d0d;
      white-space: nowrap;
    }

    .data-table td {
      padding: 12px 14px;
      border-bottom: 1px solid var(--border-subtle);
      color: var(--text-2);
      vertical-align: middle;
      font-variant-numeric: tabular-nums;
    }

    .data-table tr:last-child td {
      border-bottom: none;
    }

    .data-table tr:hover td {
      background: rgba(255, 255, 255, 0.015);
    }

    .data-table tr.is-active td {
      background: rgba(16, 185, 129, 0.025);
    }

    .acc-cell {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .acc-email {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-1);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .acc-name {
      font-size: 11px;
      color: var(--text-3);
    }

    /* Quota Micro Bars */
    .quota-cell {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 130px;
    }

    .quota-meta {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
    }

    .quota-pct {
      font-weight: 600;
      color: var(--text-1);
    }

    .quota-reset {
      font-size: 10px;
      color: var(--text-4);
      display: flex;
      align-items: center;
      gap: 3px;
    }

    .micro-bar {
      height: 4px;
      width: 100%;
      background: var(--surface-3);
      border-radius: 2px;
      overflow: hidden;
    }

    .micro-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.3s ease;
    }

    .fill-green { background: var(--green); }
    .fill-amber { background: var(--amber); }
    .fill-red { background: var(--red); }
    .fill-blue { background: var(--blue); }
    .fill-purple { background: var(--purple); }

    /* Grid Card View */
    .account-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
      gap: 14px;
    }

    .acc-card {
      background: var(--surface-1);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      transition: all 0.15s ease;
      position: relative;
    }

    .acc-card:hover {
      border-color: var(--border-muted);
    }

    .acc-card.is-active {
      border-color: var(--border-hover);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.15);
      background: #0d0d0d;
    }

    .acc-card-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
    }

    .acc-card-quotas {
      display: flex;
      flex-direction: column;
      gap: 10px;
      background: var(--surface-2);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      padding: 12px;
    }

    .acc-card-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      color: var(--text-3);
      padding-top: 4px;
    }

    /* KPI Metric Cards (Token Analytics) */
    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
    }

    .kpi-card {
      background: var(--surface-1);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 16px 18px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .kpi-label {
      font-size: 11px;
      font-weight: 500;
      color: var(--text-3);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .kpi-value {
      font-size: 24px;
      font-weight: 600;
      color: var(--text-1);
      letter-spacing: -0.5px;
      font-variant-numeric: tabular-nums;
    }

    .kpi-sub {
      font-size: 11px;
      color: var(--text-4);
    }

    /* Daily Chart */
    .chart-box {
      background: var(--surface-1);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 18px 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .chart-container {
      display: grid;
      grid-template-columns: repeat(14, 1fr);
      gap: 8px;
      height: 140px;
      align-items: end;
      padding-top: 10px;
      border-bottom: 1px solid var(--border-subtle);
    }

    .chart-bar-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 100%;
      justify-content: flex-end;
      gap: 6px;
    }

    .chart-bar-pillar {
      width: 100%;
      max-width: 28px;
      border-radius: 3px 3px 0 0;
      background: var(--surface-3);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      transition: height 0.3s ease;
    }

    .chart-bar-pillar:hover {
      background: var(--surface-hover);
    }

    .chart-label {
      font-size: 10px;
      color: var(--text-4);
      white-space: nowrap;
    }

    /* Logs & Streams */
    .stream-panel {
      background: #050505;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-lg);
      padding: 12px 14px;
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-2);
      height: 120px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .stream-line {
      display: flex;
      gap: 8px;
      line-height: 1.5;
    }

    .stream-ts {
      color: var(--text-4);
      flex-shrink: 0;
    }

    .stream-tag {
      color: var(--blue);
      flex-shrink: 0;
    }

    /* SQLite Logs Filter Bar */
    .filter-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .input-text, .select-control {
      height: 30px;
      padding: 0 10px;
      background: var(--surface-2);
      border: 1px solid var(--border-muted);
      border-radius: var(--radius-md);
      color: var(--text-1);
      font-size: 12px;
      outline: none;
      transition: border-color 0.15s ease;
    }

    .input-text:focus, .select-control:focus {
      border-color: var(--text-3);
    }

    .input-search-wrap {
      position: relative;
      display: flex;
      align-items: center;
    }

    .input-search-wrap .search-icon {
      position: absolute;
      left: 9px;
      width: 13px;
      height: 13px;
      color: var(--text-4);
      pointer-events: none;
    }

    .input-search-wrap input {
      padding-left: 28px;
      padding-right: 32px;
      width: 220px;
    }

    .input-search-wrap .shortcut-key {
      position: absolute;
      right: 8px;
      pointer-events: none;
    }

    /* Settings Panel */
    .settings-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 14px;
    }

    .settings-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 0;
      border-bottom: 1px solid var(--border-subtle);
    }

    .settings-row:last-child {
      border-bottom: none;
    }

    .settings-info {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .settings-label {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-1);
    }

    .settings-desc {
      font-size: 11px;
      color: var(--text-3);
    }

    /* Modal / Inspector */
    .modal-backdrop {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.7);
      backdrop-filter: blur(4px);
      z-index: 100;
      display: none;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }

    .modal-box {
      background: #0d0d0d;
      border: 1px solid var(--border-muted);
      border-radius: var(--radius-lg);
      width: 100%;
      max-width: 680px;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
      box-shadow: 0 20px 40px rgba(0,0,0,0.8);
      overflow: hidden;
    }

    .modal-header {
      padding: 14px 18px;
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .modal-body {
      padding: 18px;
      overflow-y: auto;
      font-size: 12px;
    }

    .modal-footer {
      padding: 12px 18px;
      border-top: 1px solid var(--border-subtle);
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      background: #080808;
    }

    pre code {
      font-family: var(--font-mono);
      font-size: 11px;
      color: #d4d4d8;
    }

    .spin {
      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      100% { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <!-- Titlebar -->
  <div class="titlebar">Antigravity Gateway &bull; Multi-Account Quota Shield</div>

  <div class="container">
    <!-- Topbar Header -->
    <header class="header">
      <div class="brand">
        <div class="brand-icon">
          <i data-lucide="layers" style="width: 16px; height: 16px;"></i>
        </div>
        <div class="brand-text">
          <div class="brand-title-wrap">
            <span class="brand-title">Antigravity Harness</span>
            <span class="badge-tag">v1.2.0</span>
          </div>
          <div class="brand-meta">
            <span class="pulse-dot"></span>
            <span id="header-conn-status">127.0.0.1:8045</span>
            <span style="color: var(--text-4);">&bull;</span>
            <span id="header-ide-sync" style="color: var(--text-3);">IDE Linked</span>
          </div>
        </div>
      </div>

      <div class="header-right">
        <!-- Active Session Pill -->
        <div class="telemetry-pill" id="pill-active-session" title="Account currently signed into Antigravity IDE">
          <i data-lucide="user-check" style="width: 13px; height: 13px; color: var(--green);"></i>
          <span style="color: var(--text-3);">Active:</span>
          <strong id="header-active-email">Detecting...</strong>
        </div>

        <!-- Next Reset Pill -->
        <div class="telemetry-pill" id="pill-next-reset" title="Earliest upcoming quota reset window">
          <i data-lucide="clock" style="width: 13px; height: 13px; color: var(--amber);"></i>
          <span style="color: var(--text-3);">Next Reset:</span>
          <strong id="header-reset-timer">Calculating...</strong>
        </div>

        <!-- Next Recommended Pill -->
        <div class="telemetry-pill" id="pill-next-rec" title="Highest headroom account recommended next">
          <i data-lucide="sparkles" style="width: 12px; height: 12px; color: var(--blue);"></i>
          <span style="color: var(--text-3);">Next in Line:</span>
          <strong id="header-next-rec" style="color: var(--blue);">Calculating...</strong>
        </div>

        <!-- Smart Shield Pill -->
        <div class="telemetry-pill interactive" id="pill-shield-status" onclick="switchTab('pane-shield')" title="Click to configure Smart Shield">
          <i data-lucide="shield-check" style="width: 13px; height: 13px; color: var(--green);"></i>
          <span style="color: var(--text-3);">Shield:</span>
          <strong id="header-shield-val">Armed (&lt;20%)</strong>
        </div>

        <!-- Actions -->
        <button class="btn btn-primary" onclick="addAccount()">
          <i data-lucide="plus" style="width: 13px; height: 13px;"></i>
          <span>Add Account</span>
        </button>

        <button class="btn btn-secondary" id="btn-sync" onclick="refreshLiveQuotas()" title="Refresh live quotas from Google Cloud Code (Shortcut: r)">
          <i data-lucide="rotate-cw" id="sync-icon" style="width: 13px; height: 13px;"></i>
          <span id="sync-text">Sync Quotas</span>
        </button>

        <button class="btn btn-secondary btn-icon" onclick="launchDesktop()" title="Open Antigravity IDE (Shortcut: ⌘O)">
          <i data-lucide="external-link" style="width: 13px; height: 13px;"></i>
        </button>

        <button class="btn btn-ghost btn-icon" onclick="openShortcutsModal()" title="Keyboard Shortcuts (Shortcut: ?)">
          <kbd>?</kbd>
        </button>
      </div>
    </header>

    <!-- Navigation Tabs -->
    <div class="nav-tabs-bar">
      <nav class="nav-tabs">
        <button class="nav-tab active" data-tab="pane-accounts" onclick="switchTab('pane-accounts')">
          <i data-lucide="users" style="width: 13px; height: 13px;"></i>
          <span>Accounts</span>
          <span class="nav-tab-badge" id="tab-badge-accounts">4</span>
        </button>

        <button class="nav-tab" data-tab="pane-shield" onclick="switchTab('pane-shield')">
          <i data-lucide="shield" style="width: 13px; height: 13px;"></i>
          <span>Smart Shield &amp; Routing</span>
        </button>

        <button class="nav-tab" data-tab="pane-analytics" onclick="switchTab('pane-analytics')">
          <i data-lucide="bar-chart-2" style="width: 13px; height: 13px;"></i>
          <span>Analytics &amp; Savings</span>
          <span class="nav-tab-badge" id="tab-badge-savings" style="color: var(--green);">$0.00 Saved</span>
        </button>

        <button class="nav-tab" data-tab="pane-logs" onclick="switchTab('pane-logs')">
          <i data-lucide="terminal" style="width: 13px; height: 13px;"></i>
          <span>Request Logs</span>
          <span class="pulse-dot"></span>
        </button>

        <button class="nav-tab" data-tab="pane-api" onclick="switchTab('pane-api')">
          <i data-lucide="code-2" style="width: 13px; height: 13px;"></i>
          <span>Universal API</span>
        </button>
      </nav>

      <div class="nav-right-meta">
        <span id="nav-headroom-meta">Pool Headroom: <strong>Healthy</strong></span>
      </div>
    </div>

    <!-- PANE 1: Accounts -->
    <div class="tab-pane active" id="pane-accounts">
      <div class="view-toolbar">
        <div class="section-heading">
          <span>Account Pool</span>
          <span class="section-sub">&bull; <span id="table-acc-count">0</span> accounts monitored with real-time quota failover</span>
        </div>

        <div style="display: flex; align-items: center; gap: 8px;">
          <div class="segmented-control">
            <button class="segmented-btn active" id="btn-view-table" onclick="setViewMode('table')" title="Table View (Shortcut: t)">
              <i data-lucide="table" style="width: 12px; height: 12px;"></i>
              <span>Table</span>
            </button>
            <button class="segmented-btn" id="btn-view-grid" onclick="setViewMode('grid')" title="Card Grid View (Shortcut: t)">
              <i data-lucide="layout-grid" style="width: 12px; height: 12px;"></i>
              <span>Cards</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Table View Container -->
      <div class="table-container" id="view-table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 44px; text-align: center;">KEY</th>
              <th style="width: 110px;">STATUS</th>
              <th>ACCOUNT</th>
              <th style="min-width: 160px;">GEMINI PRO (WEEKLY)</th>
              <th style="min-width: 160px;">5H BURST HEADROOM</th>
              <th style="min-width: 160px;">CLAUDE / 3P QUOTA</th>
              <th style="width: 140px;">USAGE STATS</th>
              <th style="width: 100px; text-align: right;">ACTION</th>
            </tr>
          </thead>
          <tbody id="accounts-table-body">
            <!-- Dynamic Rows -->
          </tbody>
        </table>
      </div>

      <!-- Card Grid View Container -->
      <div class="account-grid" id="view-grid-wrapper" style="display: none;">
        <!-- Dynamic Cards -->
      </div>
    </div>

    <!-- PANE 2: Smart Shield & Routing -->
    <div class="tab-pane" id="pane-shield">
      <div class="section-heading">
        <span>Smart Quota Shield Configuration</span>
        <span class="section-sub">&bull; Automatic proactive failover between tasks without breaking conversations</span>
      </div>

      <div class="settings-grid">
        <!-- Card 1: Thresholds -->
        <div class="card">
          <div style="font-size: 13px; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; gap: 6px;">
            <i data-lucide="gauge" style="width: 14px; height: 14px; color: var(--blue);"></i>
            <span>Failover Thresholds</span>
          </div>

          <div class="settings-row">
            <div class="settings-info">
              <span class="settings-label">Switch When Weekly Below</span>
              <span class="settings-desc">Proactive switch buffer for weekly limit</span>
            </div>
            <select class="select-control" id="shield-weekly-threshold" onchange="saveShieldSetting({ weeklyThreshold: parseInt(this.value, 10) })">
              <option value="5">&lt; 5%</option>
              <option value="10">&lt; 10%</option>
              <option value="15">&lt; 15%</option>
              <option value="20" selected>&lt; 20%</option>
              <option value="25">&lt; 25%</option>
              <option value="30">&lt; 30%</option>
              <option value="40">&lt; 40%</option>
              <option value="50">&lt; 50%</option>
            </select>
          </div>

          <div class="settings-row">
            <div class="settings-info">
              <span class="settings-label">Switch When 5-Hour Burst Below</span>
              <span class="settings-desc">Proactive switch buffer for 5h window</span>
            </div>
            <select class="select-control" id="shield-5h-threshold" onchange="saveShieldSetting({ burstThreshold: parseInt(this.value, 10) })">
              <option value="5">&lt; 5%</option>
              <option value="10">&lt; 10%</option>
              <option value="15">&lt; 15%</option>
              <option value="20" selected>&lt; 20%</option>
              <option value="25">&lt; 25%</option>
              <option value="30">&lt; 30%</option>
              <option value="40">&lt; 40%</option>
              <option value="50">&lt; 50%</option>
            </select>
          </div>

          <div class="settings-row">
            <div class="settings-info">
              <span class="settings-label">Auto-Switch Protection</span>
              <span class="settings-desc">Enable background proactive account rotation</span>
            </div>
            <input type="checkbox" id="smart-shield-toggle" checked onchange="toggleSmartShield(this.checked)" style="width: 16px; height: 16px; accent-color: var(--green); cursor: pointer;">
          </div>
        </div>

        <!-- Card 2: Model & Account Routing -->
        <div class="card">
          <div style="font-size: 13px; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; gap: 6px;">
            <i data-lucide="sliders" style="width: 14px; height: 14px; color: var(--purple);"></i>
            <span>Model &amp; Account Policies</span>
          </div>

          <div class="settings-row">
            <div class="settings-info">
              <span class="settings-label">Watch Limits Of</span>
              <span class="settings-desc" id="shield-models-detected">Auto-detect from conversation model</span>
            </div>
            <select class="select-control" id="shield-models" onchange="saveShieldSetting({ models: this.value })">
              <option value="auto" selected>Auto-detect from model in use</option>
              <option value="gemini">Gemini Only</option>
              <option value="claude">Claude / GPT Only</option>
              <option value="both">Both Families</option>
            </select>
          </div>

          <div class="settings-row">
            <div class="settings-info">
              <span class="settings-label">Main Account (Affinity)</span>
              <span class="settings-desc">Automatically return once recovered</span>
            </div>
            <select class="select-control" id="shield-primary" onchange="saveShieldSetting({ primaryEmail: this.value })">
              <option value="">None (spend quota that expires first)</option>
            </select>
          </div>

          <div class="settings-row">
            <div class="settings-info">
              <span class="settings-label">Auto-Continue After Limit</span>
              <span class="settings-desc">Send 'continue' automatically after hard quota</span>
            </div>
            <input type="checkbox" id="shield-auto-continue" onchange="saveShieldSetting({ autoContinue: this.checked })" style="width: 16px; height: 16px; accent-color: var(--green); cursor: pointer;">
          </div>
        </div>
      </div>
    </div>

    <!-- PANE 3: Token Analytics & Cost Saved -->
    <div class="tab-pane" id="pane-analytics">
      <div class="section-heading">
        <span>Token Telemetry &amp; API Cost Savings</span>
        <span class="section-sub">&bull; Calculated against standard Google Cloud Pro rates</span>
      </div>

      <div class="kpi-grid">
        <div class="kpi-card">
          <div class="kpi-label">
            <span>Total Tokens Processed</span>
            <i data-lucide="layers" style="width: 13px; height: 13px; color: var(--text-3);"></i>
          </div>
          <div class="kpi-value" id="stat-total-tokens">0</div>
          <div class="kpi-sub">Across all conversations &amp; agents</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-label">
            <span>Input / Context Tokens</span>
            <i data-lucide="arrow-up-right" style="width: 13px; height: 13px; color: var(--blue);"></i>
          </div>
          <div class="kpi-value" id="stat-input-tokens" style="color: var(--blue);">0</div>
          <div class="kpi-sub">Prompts, files, system instructions</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-label">
            <span>Output Completion Tokens</span>
            <i data-lucide="arrow-down-left" style="width: 13px; height: 13px; color: var(--green);"></i>
          </div>
          <div class="kpi-value" id="stat-output-tokens" style="color: var(--green);">0</div>
          <div class="kpi-sub">Agent tool calls and completions</div>
        </div>

        <div class="kpi-card">
          <div class="kpi-label">
            <span>Commercial API Value Saved</span>
            <i data-lucide="dollar-sign" style="width: 13px; height: 13px; color: var(--green);"></i>
          </div>
          <div class="kpi-value" id="stat-money-saved" style="color: var(--green);">$0.00</div>
          <div class="kpi-sub">Cumulative free quota utilized</div>
        </div>
      </div>

      <!-- 14-Day Velocity Chart -->
      <div class="chart-box">
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
          <div>
            <div style="font-size: 13px; font-weight: 600;">14-Day Token Velocity &amp; Daily Savings</div>
            <div style="font-size: 11px; color: var(--text-3);">Daily token throughput from local agent sessions</div>
          </div>
          <div id="chart-saved-badge" class="status-badge active-now">$0.00 Saved Today</div>
        </div>

        <div class="chart-container" id="daily-chart-container">
          <!-- Injected via JavaScript -->
        </div>

        <!-- Model Traffic Distribution -->
        <div style="display: flex; flex-direction: column; gap: 6px; padding-top: 4px;">
          <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11px;">
            <span style="color: var(--text-3); font-weight: 500;">Model Distribution</span>
            <span id="model-share-summary" style="color: var(--text-2);">Gemini 3.8 Flash (100%)</span>
          </div>
          <div class="micro-bar" id="model-share-bar" style="height: 6px; display: flex;">
            <!-- Injected via JavaScript -->
          </div>
        </div>
      </div>
    </div>

    <!-- PANE 4: Request Logs -->
    <div class="tab-pane" id="pane-logs">
      <!-- Live Event Stream -->
      <div class="section-heading">
        <span>Live Dispatch Stream</span>
        <span class="section-sub">&bull; Real-time event notifications via SSE</span>
      </div>

      <div class="stream-panel" id="stream-box">
        <div class="stream-line">
          <span class="stream-ts">[INIT]</span>
          <span class="stream-tag">[HARNESS]</span>
          <span>Gateway active on 127.0.0.1:8045. Multi-account routing armed.</span>
        </div>
      </div>

      <!-- SQLite Persistent Request History -->
      <div class="view-toolbar" style="margin-top: 8px;">
        <div class="section-heading">
          <span>Persistent Request History (SQLite)</span>
          <span class="section-sub">&bull; Stored in data/harness.db</span>
        </div>

        <div class="filter-bar">
          <div class="input-search-wrap">
            <i data-lucide="search" class="search-icon"></i>
            <input type="text" class="input-text" id="log-search-input" placeholder="Search requests..." oninput="debounceFilterLogs()">
            <kbd class="shortcut-key">/</kbd>
          </div>

          <select class="select-control" id="log-account-filter" onchange="fetchDbLogs()">
            <option value="">All Accounts</option>
          </select>

          <select class="select-control" id="log-model-filter" onchange="fetchDbLogs()">
            <option value="">All Models</option>
            <option value="gemini-3.8-flash">Gemini 3.8 Flash</option>
            <option value="gemini-3.7-flash">Gemini 3.7 Flash</option>
            <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
            <option value="claude-3-5-sonnet">Claude 3.5 Sonnet</option>
          </select>

          <select class="select-control" id="log-limit-select" onchange="changeLogPageSize(this.value)">
            <option value="15">15 / page</option>
            <option value="30" selected>30 / page</option>
            <option value="50">50 / page</option>
            <option value="100">100 / page</option>
          </select>

          <button class="btn btn-secondary btn-icon" onclick="fetchDbLogs()" title="Refresh Logs">
            <i data-lucide="rotate-cw" style="width: 12px; height: 12px;"></i>
          </button>
        </div>
      </div>

      <div class="table-container">
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 80px;">STATUS</th>
              <th style="width: 90px;">REQ ID</th>
              <th>ACCOUNT</th>
              <th>MODEL</th>
              <th>LATENCY</th>
              <th>TOKENS</th>
              <th>TIMESTAMP</th>
              <th style="width: 70px; text-align: right;">INSPECT</th>
            </tr>
          </thead>
          <tbody id="db-logs-tbody">
            <!-- Dynamic Log Rows -->
          </tbody>
        </table>
      </div>

      <!-- Pagination Footer -->
      <div style="display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--text-3);">
        <span id="log-pagination-info">Showing 0 of 0 requests</span>
        <div style="display: flex; gap: 6px;">
          <button class="btn btn-secondary btn-sm" id="btn-log-prev" onclick="goToLogPage(currentLogPage - 1)" disabled>Previous</button>
          <button class="btn btn-secondary btn-sm" id="btn-log-next" onclick="goToLogPage(currentLogPage + 1)" disabled>Next</button>
        </div>
      </div>
    </div>

    <!-- PANE 5: Universal API -->
    <div class="tab-pane" id="pane-api">
      <div class="section-heading">
        <span>Universal API &amp; Protocol Translator</span>
        <span class="section-sub">&bull; Use Antigravity's pooled Pro accounts in any OpenAI or Anthropic tool</span>
      </div>

      <div class="settings-grid">
        <div class="card">
          <div style="font-size: 13px; font-weight: 600; margin-bottom: 8px;">OpenAI Compatible Endpoint</div>
          <div style="font-size: 11px; color: var(--text-3); margin-bottom: 12px;">Compatible with Cursor, Cline, Continue, Aider, and standard OpenAI SDKs.</div>
          <div style="background: #080808; border: 1px solid var(--border-subtle); border-radius: 6px; padding: 12px; font-family: var(--font-mono); font-size: 11px; color: #d4d4d8; position: relative;">
            <pre><code>curl http://127.0.0.1:8045/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "gemini-3.8-flash",
    "messages": [{"role": "user", "content": "Hello"}]
  }'</code></pre>
            <button class="btn btn-secondary btn-sm" style="position: absolute; top: 8px; right: 8px;" onclick="copySnippet(\`curl http://127.0.0.1:8045/v1/chat/completions -H 'Content-Type: application/json' -d '{\"model\":\"gemini-3.8-flash\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}'\`, this)">Copy</button>
          </div>
        </div>

        <div class="card">
          <div style="font-size: 13px; font-weight: 600; margin-bottom: 8px;">Anthropic Compatible Endpoint</div>
          <div style="font-size: 11px; color: var(--text-3); margin-bottom: 12px;">Direct protocol support for Anthropic Messages API.</div>
          <div style="background: #080808; border: 1px solid var(--border-subtle); border-radius: 6px; padding: 12px; font-family: var(--font-mono); font-size: 11px; color: #d4d4d8; position: relative;">
            <pre><code>curl http://127.0.0.1:8045/v1/messages \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-3-5-sonnet",
    "messages": [{"role": "user", "content": "Hello"}]
  }'</code></pre>
            <button class="btn btn-secondary btn-sm" style="position: absolute; top: 8px; right: 8px;" onclick="copySnippet(\`curl http://127.0.0.1:8045/v1/messages -H 'Content-Type: application/json' -d '{\"model\":\"claude-3-5-sonnet\",\"messages\":[{\"role\":\"user\",\"content\":\"Hello\"}]}'\`, this)">Copy</button>
          </div>
        </div>
      </div>

      <!-- Interactive Test Ping Console -->
      <div class="card" style="margin-top: 6px;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px;">
          <div>
            <div style="font-size: 13px; font-weight: 600;">Live Gateway Test Console</div>
            <div style="font-size: 11px; color: var(--text-3);">Send a live test completion through the active account pool</div>
          </div>
          <button class="btn btn-primary" id="btn-run-test" onclick="runProxyTest()">
            <i data-lucide="play" style="width: 12px; height: 12px;"></i>
            <span id="btn-test-text">Send Test Ping</span>
          </button>
        </div>

        <div id="test-result-box" style="display: none; background: #080808; border: 1px solid var(--border-subtle); border-radius: 6px; padding: 12px; font-family: var(--font-mono); font-size: 11px;">
          <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
            <span id="test-result-status" style="font-weight: 600; color: var(--green);">&bull; 200 OK</span>
            <span id="test-result-meta" style="color: var(--text-4);">Latency: 0ms</span>
          </div>
          <div id="test-result-text" style="color: #ededed;"></div>
        </div>
      </div>
    </div>
  </div>

  <!-- Inspector Modal (for SQLite Log inspection) -->
  <div class="modal-backdrop" id="inspector-modal">
    <div class="modal-box">
      <div class="modal-header">
        <div style="font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px;">
          <i data-lucide="file-text" style="width: 14px; height: 14px; color: var(--blue);"></i>
          <span>Request Inspector</span>
          <span class="badge-tag" id="inspector-id">REQ #0</span>
        </div>
        <button class="btn btn-ghost btn-icon-sm" onclick="closeInspector()">
          <i data-lucide="x" style="width: 14px; height: 14px;"></i>
        </button>
      </div>
      <div class="modal-body">
        <pre><code id="inspector-content">// Loading request details...</code></pre>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary btn-sm" id="btn-copy-inspector" onclick="copyInspectorData()">Copy JSON</button>
        <button class="btn btn-secondary btn-sm" onclick="closeInspector()">Close</button>
      </div>
    </div>
  </div>

  <!-- Keyboard Shortcuts Modal -->
  <div class="modal-backdrop" id="shortcuts-modal">
    <div class="modal-box" style="max-width: 440px;">
      <div class="modal-header">
        <div style="font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 8px;">
          <i data-lucide="command" style="width: 14px; height: 14px;"></i>
          <span>Keyboard Shortcuts</span>
        </div>
        <button class="btn btn-ghost btn-icon-sm" onclick="closeShortcutsModal()">
          <i data-lucide="x" style="width: 14px; height: 14px;"></i>
        </button>
      </div>
      <div class="modal-body" style="display: flex; flex-direction: column; gap: 10px;">
        <div style="display: flex; align-items: center; justify-content: space-between; padding-bottom: 6px; border-bottom: 1px solid var(--border-subtle);">
          <span style="color: var(--text-2);">Switch to Account 1 &ndash; 9</span>
          <span style="display: flex; gap: 4px;"><kbd>1</kbd> &hellip; <kbd>9</kbd></span>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; padding-bottom: 6px; border-bottom: 1px solid var(--border-subtle);">
          <span style="color: var(--text-2);">Search / Filter Logs</span>
          <kbd>/</kbd>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; padding-bottom: 6px; border-bottom: 1px solid var(--border-subtle);">
          <span style="color: var(--text-2);">Sync Live Google Quotas</span>
          <kbd>r</kbd>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; padding-bottom: 6px; border-bottom: 1px solid var(--border-subtle);">
          <span style="color: var(--text-2);">Toggle Table / Cards View</span>
          <kbd>t</kbd>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; padding-bottom: 6px; border-bottom: 1px solid var(--border-subtle);">
          <span style="color: var(--text-2);">Close Modals &amp; Inspectors</span>
          <kbd>Esc</kbd>
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span style="color: var(--text-2);">Open This Cheatsheet</span>
          <kbd>?</kbd>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary btn-sm" onclick="closeShortcutsModal()">Got it</button>
      </div>
    </div>
  </div>

  <script>
    let activeRunningId = null;
    let isSyncing = false;
    let bestAccountId = null;
    let currentLogPage = 1;
    let currentLogLimit = 30;
    let logSearchDebounce = null;
    let cachedAccountsList = [];
    let nextResetTimestamp = null;
    let currentViewMode = localStorage.getItem('harness_view_mode') || 'table';

    function setViewMode(mode) {
      currentViewMode = mode;
      localStorage.setItem('harness_view_mode', mode);
      const btnTable = document.getElementById('btn-view-table');
      const btnGrid = document.getElementById('btn-view-grid');
      const tableWrap = document.getElementById('view-table-wrapper');
      const gridWrap = document.getElementById('view-grid-wrapper');

      if (mode === 'grid') {
        if (btnTable) btnTable.classList.remove('active');
        if (btnGrid) btnGrid.classList.add('active');
        if (tableWrap) tableWrap.style.display = 'none';
        if (gridWrap) gridWrap.style.display = 'grid';
      } else {
        if (btnGrid) btnGrid.classList.remove('active');
        if (btnTable) btnTable.classList.add('active');
        if (gridWrap) gridWrap.style.display = 'none';
        if (tableWrap) tableWrap.style.display = 'block';
      }
    }

    function switchTab(tabId) {
      document.querySelectorAll('.tab-pane').forEach(el => el.classList.remove('active'));
      document.querySelectorAll('.nav-tab').forEach(el => el.classList.remove('active'));

      const targetPane = document.getElementById(tabId);
      const targetTabBtn = document.querySelector(\`.nav-tab[data-tab="\${tabId}"]\`);

      if (targetPane) targetPane.classList.add('active');
      if (targetTabBtn) targetTabBtn.classList.add('active');
      localStorage.setItem('harness_active_tab', tabId);

      if (tabId === 'pane-logs') {
        fetchDbLogs();
      }
      if (window.lucide && typeof lucide.createIcons === 'function') {
        lucide.createIcons();
      }
    }

    // Modal Handlers
    function openShortcutsModal() {
      const modal = document.getElementById('shortcuts-modal');
      if (modal) modal.style.display = 'flex';
    }

    function closeShortcutsModal() {
      const modal = document.getElementById('shortcuts-modal');
      if (modal) modal.style.display = 'none';
    }

    function openInspector(logId) {
      const modal = document.getElementById('inspector-modal');
      const content = document.getElementById('inspector-content');
      const idTag = document.getElementById('inspector-id');
      if (idTag) idTag.innerText = \`REQ #\${logId}\`;
      if (content) content.innerText = '// Loading request payload...';
      if (modal) modal.style.display = 'flex';

      fetch(\`/api/db/logs?search=\${logId}&limit=1\`)
        .then(r => r.json())
        .then(data => {
          const item = data.logs?.[0];
          if (item) {
            content.innerText = JSON.stringify(item, null, 2);
          } else {
            content.innerText = '// Record not found';
          }
        })
        .catch(err => {
          content.innerText = '// Error loading details: ' + err.message;
        });
    }

    function closeInspector() {
      const modal = document.getElementById('inspector-modal');
      if (modal) modal.style.display = 'none';
    }

    function copyInspectorData() {
      const content = document.getElementById('inspector-content');
      if (content) {
        navigator.clipboard.writeText(content.innerText);
        const btn = document.getElementById('btn-copy-inspector');
        if (btn) {
          const original = btn.innerText;
          btn.innerText = 'Copied!';
          setTimeout(() => { btn.innerText = original; }, 1500);
        }
      }
    }

    // Live Reset Countdown Timer (Updates every second)
    function updateResetCountdown() {
      const timerEl = document.getElementById('header-reset-timer');
      if (!timerEl || !nextResetTimestamp) return;

      const diffMs = nextResetTimestamp - Date.now();
      if (diffMs <= 0) {
        timerEl.innerText = 'Resetting now...';
        return;
      }

      const totalSec = Math.floor(diffMs / 1000);
      const hours = Math.floor(totalSec / 3600);
      const mins = Math.floor((totalSec % 3600) / 60);
      const secs = totalSec % 60;

      if (hours > 0) {
        timerEl.innerText = \`\${hours}h \${mins}m \${secs}s\`;
      } else {
        timerEl.innerText = \`\${mins}m \${secs}s\`;
      }
    }
    setInterval(updateResetCountdown, 1000);

    // Helpers
    function getBarColor(pct) {
      if (pct > 50) return 'fill-green';
      if (pct > 20) return 'fill-amber';
      return 'fill-red';
    }

    function formatNumber(num) {
      if (num === null || num === undefined) return '0';
      if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
      if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
      return String(num);
    }

    function copySnippet(text, btnElement) {
      navigator.clipboard.writeText(text);
      if (btnElement) {
        const originalText = btnElement.innerText;
        btnElement.innerText = 'Copied!';
        setTimeout(() => { btnElement.innerText = originalText; }, 1500);
      }
    }

    // Smart Shield Config
    async function fetchSmartShieldConfig() {
      try {
        const res = await fetch('/api/config/smart-shield');
        if (!res.ok) return;
        const data = await res.json();
        const toggle = document.getElementById('smart-shield-toggle');
        const headerPill = document.getElementById('header-shield-val');

        const enabled = data.enabled !== false;
        if (toggle) toggle.checked = enabled;
        if (headerPill) {
          headerPill.innerText = enabled ? \`Armed (<\${data.weeklyThreshold || 20}%)\` : 'Disabled';
          headerPill.style.color = enabled ? 'var(--text-1)' : 'var(--text-3)';
        }

        const set = (id, val) => { const el = document.getElementById(id); if (el && val !== undefined) el.value = String(val); };
        set('shield-weekly-threshold', data.weeklyThreshold);
        set('shield-5h-threshold', data.burstThreshold);
        set('shield-models', data.models || 'auto');
        
        const primary = document.getElementById('shield-primary');
        if (primary && Array.isArray(data.accounts)) {
          primary.innerHTML = '<option value="">None (spend quota that expires first)</option>' +
            data.accounts.map(e => \`<option value="\${e}">\${e}</option>\`).join('');
          primary.value = data.primaryEmail || '';
        }
        const auto = document.getElementById('shield-auto-continue');
        if (auto) auto.checked = !!data.autoContinue;

        const detected = document.getElementById('shield-models-detected');
        if (detected) {
          const fams = data.detectedModels?.families;
          detected.innerText = data.models === 'auto'
            ? (fams && fams.length ? \`(active: \${fams.map(f => f === 'claude' ? 'Claude/GPT' : 'Gemini').join(' + ')})\` : 'Watching both until detected')
            : '';
        }
      } catch (e) {}
    }

    async function toggleSmartShield(enabled) {
      await saveShieldSetting({ enabled });
      const headerPill = document.getElementById('header-shield-val');
      if (headerPill) {
        headerPill.innerText = enabled ? 'Armed (<20%)' : 'Disabled';
      }
    }

    async function saveShieldSetting(change) {
      try {
        const res = await fetch('/api/config/smart-shield', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(change)
        });
        const updated = await res.json();
        addLog(\`🛡️ Smart Shield settings updated.\`);
        fetchSmartShieldConfig();
      } catch (e) {
        console.error('Error saving Smart Shield setting:', e);
      }
    }

    // SQLite Logs Handlers
    function debounceFilterLogs() {
      clearTimeout(logSearchDebounce);
      logSearchDebounce = setTimeout(() => {
        currentLogPage = 1;
        fetchDbLogs();
      }, 300);
    }

    function changeLogPageSize(size) {
      currentLogLimit = parseInt(size, 10) || 30;
      currentLogPage = 1;
      fetchDbLogs();
    }

    function goToLogPage(page) {
      if (page < 1) return;
      currentLogPage = page;
      fetchDbLogs();
    }

    async function fetchDbLogs() {
      const search = document.getElementById('log-search-input')?.value || '';
      const account = document.getElementById('log-account-filter')?.value || '';
      const model = document.getElementById('log-model-filter')?.value || '';
      const tbody = document.getElementById('db-logs-tbody');
      const info = document.getElementById('log-pagination-info');
      const btnPrev = document.getElementById('btn-log-prev');
      const btnNext = document.getElementById('btn-log-next');

      try {
        const query = new URLSearchParams({
          page: currentLogPage,
          limit: currentLogLimit,
          search,
          account,
          model
        });
        const res = await fetch(\`/api/db/logs?\${query.toString()}\`);
        if (!res.ok) return;
        const data = await res.json();
        const logs = data.logs || [];
        const pag = data.pagination || { total: 0, totalPages: 1 };

        if (info) {
          const start = pag.total === 0 ? 0 : (pag.page - 1) * pag.limit + 1;
          const end = Math.min(pag.page * pag.limit, pag.total);
          info.innerText = \`Showing \${start}–\${end} of \${pag.total} requests (Page \${pag.page} of \${pag.totalPages})\`;
        }

        if (btnPrev) btnPrev.disabled = !pag.hasPrev;
        if (btnNext) btnNext.disabled = !pag.hasNext;

        if (logs.length === 0) {
          tbody.innerHTML = '<tr><td colspan="8" style="text-align:center; padding: 24px; color: var(--text-4);">No requests matching criteria</td></tr>';
          return;
        }

        tbody.innerHTML = logs.map(l => {
          let statusBadge = '<span class="status-badge active-now">200 OK</span>';
          if (l.status_code === 429) statusBadge = '<span class="status-badge queued">429 Quota</span>';
          else if (l.status_code === 403) statusBadge = '<span class="status-badge restricted">403 Banned</span>';
          else if (l.status_code >= 400) statusBadge = \`<span class="status-badge restricted">\${l.status_code} Err</span>\`;

          const timeStr = l.created_at ? new Date(l.created_at).toLocaleTimeString() : '';
          const tokStr = \`↑\${l.input_tokens || 0} ↓\${l.output_tokens || 0}\`;

          return \`
            <tr>
              <td>\${statusBadge}</td>
              <td style="font-family: var(--font-mono); font-size: 11px; color: var(--text-3);">#\${l.request_id || l.id}</td>
              <td style="font-weight: 500; color: var(--text-1);">\${l.account_email || 'anonymous'}</td>
              <td style="font-family: var(--font-mono); font-size: 11px; color: var(--blue);">\${l.model || 'auto'}</td>
              <td>\${l.latency_ms || 0}ms</td>
              <td>\${tokStr}</td>
              <td style="color: var(--text-4); font-size: 11px;">\${timeStr}</td>
              <td style="text-align: right;">
                <button class="btn btn-ghost btn-sm" onclick="openInspector(\${l.request_id || l.id})">Inspect</button>
              </td>
            </tr>
          \`;
        }).join('');
      } catch (err) {
        console.error('Error fetching SQLite logs:', err);
      }
    }

    // Account Ranking & Priority Sort
    function calculateAccountScore(acc) {
      if (acc.is403Banned) return -99999;
      if (acc.cooldownUntil && acc.cooldownUntil > Date.now()) return -500;
      const gw = acc.geminiWeekly?.pct ?? 100;
      const g5 = acc.gemini5h?.pct ?? 100;
      const cw = acc.claudeWeekly?.pct ?? 100;
      const c5 = acc.claude5h?.pct ?? 100;
      return (gw * 0.45) + (g5 * 0.35) + (cw * 0.1) + (c5 * 0.1);
    }

    function sortAccountsPool(accounts, activeId, activeEmail) {
      const emailLower = (activeEmail || '').toLowerCase();
      const active = accounts.find(a => 
        (activeId && a.id === activeId) || 
        (emailLower && a.email && a.email.toLowerCase() === emailLower)
      );
      const others = accounts.filter(a => a !== active);
      others.sort((a, b) => calculateAccountScore(b) - calculateAccountScore(a));
      return active ? [active, ...others] : others;
    }

    // Main Stats & Matrix Poller
    async function fetchMatrix() {
      try {
        const [statsRes, ideRes] = await Promise.all([
          fetch('/api/stats'),
          fetch('/api/ide-status').catch(() => null)
        ]);

        if (!statsRes.ok) return;
        const data = await statsRes.json();
        const ideStatus = ideRes && ideRes.ok ? await ideRes.json() : null;

        const rawAccounts = Object.values(data.accounts || {});

        // Populate accounts filter dropdown if needed
        const accFilter = document.getElementById('log-account-filter');
        if (accFilter && accFilter.options.length <= 1) {
          rawAccounts.forEach(a => {
            const opt = document.createElement('option');
            opt.value = a.email;
            opt.innerText = a.email;
            accFilter.appendChild(opt);
          });
        }

        // Active Session Email & Sync Status
        const activeEmail = (ideStatus?.ideEmail || data.global?.activeSessionEmail || rawAccounts[0]?.email || '').toLowerCase();
        const activeId = data.global?.activeSessionAccountId;
        const activeEmailEl = document.getElementById('header-active-email');
        if (activeEmailEl) activeEmailEl.innerText = activeEmail || 'Unknown';

        // Sort: 1st Active, 2nd Next Recommended, ... Last Lowest Quota
        const accounts = sortAccountsPool(rawAccounts, activeId, activeEmail);
        cachedAccountsList = accounts;

        const syncEl = document.getElementById('header-ide-sync');
        if (syncEl) {
          syncEl.innerText = ideStatus?.inSync ? 'IDE In-Sync' : 'Linked';
          syncEl.style.color = ideStatus?.inSync ? 'var(--green)' : 'var(--text-3)';
        }

        // Update Next Reset Countdown Timestamp
        let earliestReset = null;
        for (const a of accounts) {
          const t1 = a.gemini5h?.resetTime ? new Date(a.gemini5h.resetTime).getTime() : null;
          const t2 = a.geminiWeekly?.resetTime ? new Date(a.geminiWeekly.resetTime).getTime() : null;
          for (const t of [t1, t2]) {
            if (t && t > Date.now() && (!earliestReset || t < earliestReset)) {
              earliestReset = t;
            }
          }
        }
        nextResetTimestamp = earliestReset;
        updateResetCountdown();

        // Update KPIs
        const totalTokEl = document.getElementById('stat-total-tokens');
        if (totalTokEl) totalTokEl.innerText = formatNumber(data.global?.totalTokens || 0);

        const inTokEl = document.getElementById('stat-input-tokens');
        if (inTokEl) inTokEl.innerText = formatNumber(data.global?.inputTokens || 0);

        const outTokEl = document.getElementById('stat-output-tokens');
        if (outTokEl) outTokEl.innerText = formatNumber(data.global?.outputTokens || 0);

        const moneyEl = document.getElementById('stat-money-saved');
        if (moneyEl) moneyEl.innerText = data.global?.dollarsSavedFormatted || '$0.00';

        const tabSavings = document.getElementById('tab-badge-savings');
        if (tabSavings) tabSavings.innerText = \`\${data.global?.dollarsSavedFormatted || '$0.00'} Saved\`;

        const chartSaved = document.getElementById('chart-saved-badge');
        const todayStats = (data.global?.dailyAnalytics || [])[(data.global?.dailyAnalytics || []).length - 1];
        if (chartSaved && todayStats) {
          chartSaved.innerText = \`$\${(todayStats.dollarsSaved || 0).toFixed(2)} Saved Today\`;
        }

        // Badges
        const tabAccBadge = document.getElementById('tab-badge-accounts');
        if (tabAccBadge) tabAccBadge.innerText = String(accounts.length);
        const tblCount = document.getElementById('table-acc-count');
        if (tblCount) tblCount.innerText = String(accounts.length);

        renderDailyChart(data.global?.dailyAnalytics || []);
        renderModelShare(data.global?.modelDistribution || []);
        renderAccountsTable(accounts, data, ideStatus);
        renderAccountsGrid(accounts, data, ideStatus);

        if (window.lucide && typeof lucide.createIcons === 'function') {
          lucide.createIcons();
        }
      } catch (e) {
        console.error('Error in fetchMatrix:', e);
      }
    }

    // Render 14-Day Velocity Chart
    function renderDailyChart(dailyData = []) {
      const container = document.getElementById('daily-chart-container');
      if (!container || !dailyData || dailyData.length === 0) return;

      const maxTokens = Math.max(50, ...dailyData.map(d => d.totalTokens || 0));

      container.innerHTML = dailyData.map((day, idx) => {
        const isToday = idx === dailyData.length - 1;
        const total = day.totalTokens || 0;
        const input = day.inputTokens || 0;
        const output = day.outputTokens || 0;
        const saved = day.dollarsSaved ? \`$\${day.dollarsSaved.toFixed(2)}\` : '$0.00';

        const totalHeight = total > 0 ? Math.max(10, Math.round((total / maxTokens) * 105)) : 4;
        const inputPct = total > 0 ? Math.round((input / total) * 100) : 50;
        const outputPct = total > 0 ? (100 - inputPct) : 50;

        return \`
          <div class="chart-bar-wrap" title="\${day.label}: \${total.toLocaleString()} tokens (\${input} in / \${output} out) &bull; \${saved} saved">
            <div style="font-size: 9px; font-weight: 500; color: \${total > 0 ? 'var(--text-2)' : 'var(--text-4)'};">
              \${total > 0 ? formatNumber(total) : '0'}
            </div>
            <div class="chart-bar-pillar" style="height: \${totalHeight}px;">
              <div style="height: \${outputPct}%; background: var(--green); width: 100%;"></div>
              <div style="height: \${inputPct}%; background: var(--blue); width: 100%;"></div>
            </div>
            <div class="chart-label" style="font-weight: \${isToday ? '600' : '400'}; color: \${isToday ? 'var(--blue)' : 'var(--text-4)'};">
              \${day.dayShort || day.label}
            </div>
          </div>
        \`;
      }).join('');
    }

    function renderModelShare(models = []) {
      const bar = document.getElementById('model-share-bar');
      const summary = document.getElementById('model-share-summary');
      if (!bar || !summary) return;

      if (!models || models.length === 0) {
        bar.innerHTML = '<div style="width: 100%; background: var(--blue); height: 100%;"></div>';
        summary.innerHTML = '<span style="color: var(--blue); font-weight: 500;">Gemini 3.8 Flash (100%)</span>';
        return;
      }

      const colors = ['var(--blue)', 'var(--purple)', 'var(--green)', 'var(--amber)', '#ec4899'];
      bar.innerHTML = models.map((m, i) => \`
        <div style="width: \${m.percentage}%; background: \${colors[i % colors.length]}; height: 100%;" title="\${m.model}: \${m.percentage}% (\${formatNumber(m.totalTokens)} tokens)"></div>
      \`).join('');

      summary.innerHTML = models.map((m, i) => \`
        <span style="color: \${colors[i % colors.length]}; font-weight: 500;">\${m.model.replace('gemini-', '')} (\${m.percentage}%)</span>
      \`).join(' &bull; ');
    }

    // Render Accounts Table View
    function renderAccountsTable(accounts, data, ideStatus) {
      const tbody = document.getElementById('accounts-table-body');
      if (!tbody) return;

      const activeSessionEmail = (ideStatus?.ideEmail || data.global?.activeSessionEmail || '').toLowerCase();
      const activeSessionId = data.global?.activeSessionAccountId;
      const isGenerating = !!data.global?.isSessionGenerating;
      const pendingEmail = (data.global?.pendingSwitch?.email || '').toLowerCase();

      tbody.innerHTML = accounts.map((a, idx) => {
        const isQueued = !!pendingEmail && a.email.toLowerCase() === pendingEmail;
        const isBanned = a.is403Banned;
        const isCooling = a.cooldownUntil && a.cooldownUntil > Date.now();
        const isServing = a.id === activeRunningId;
        const isActive = a.id === activeSessionId || a.email.toLowerCase() === activeSessionEmail;
        const isNextRecommended = !isActive && idx === 1 && !isBanned;
        const isLowest = !isActive && idx === accounts.length - 1 && accounts.length > 2;

        let statusHtml = '<span class="status-badge standby">Standby</span>';
        if (isServing || (isActive && isGenerating)) {
          statusHtml = '<span class="status-badge generating"><span class="pulse-dot" style="background:var(--blue)"></span> Generating</span>';
        } else if (isActive) {
          statusHtml = '<span class="status-badge active-now"><span class="pulse-dot"></span> Active Now</span>';
        } else if (isQueued) {
          statusHtml = '<span class="status-badge queued">Switching</span>';
        } else if (isBanned) {
          statusHtml = '<span class="status-badge restricted">403 Restricted</span>';
        } else if (isCooling) {
          const rem = Math.ceil((a.cooldownUntil - Date.now()) / 1000);
          statusHtml = \`<span class="status-badge cooling">Cooling (\${rem}s)</span>\`;
        } else if (isNextRecommended) {
          statusHtml = '<span class="status-badge" style="background: rgba(59, 130, 246, 0.08); border-color: rgba(59, 130, 246, 0.25); color: var(--blue);"><i data-lucide="sparkles" style="width:10px;height:10px;"></i> Recommended</span>';
        } else if (isLowest && (gw.pct < 20 || g5.pct < 20)) {
          statusHtml = '<span class="status-badge" style="background: var(--red-subtle); border-color: var(--red-border); color: var(--red);">Lowest Quota</span>';
        }

        const gw = a.geminiWeekly || { pct: 100, resetText: 'Active' };
        const g5 = a.gemini5h || { pct: 100, resetText: 'Active' };
        const cw = a.claudeWeekly || { pct: 100, resetText: 'Active' };

        let actionBtn = \`<button class="btn btn-secondary btn-sm" onclick="setActive('\${a.id}')">Set Active</button>\`;
        if (isActive) {
          actionBtn = '<span style="color: var(--green); font-size: 11px; font-weight: 500;">Active</span>';
        } else if (isQueued) {
          actionBtn = '<span style="color: var(--amber); font-size: 11px;">Queued</span>';
        }

        const hotkey = idx < 9 ? \`<kbd>\${idx + 1}</kbd>\` : '&bull;';

        return \`
          <tr class="\${isActive ? 'is-active' : ''}">
            <td style="text-align: center;">\${hotkey}</td>
            <td>\${statusHtml}</td>
            <td>
              <div class="acc-cell">
                <span class="acc-email">\${a.email}</span>
                <span class="acc-name">\${a.name || 'Pro Account'} &bull; \${a.subscriptionTier || 'PRO'}</span>
              </div>
            </td>
            <td>
              <div class="quota-cell">
                <div class="quota-meta">
                  <span class="quota-pct">\${gw.pct}%</span>
                  <span class="quota-reset">Resets in \${gw.resetText || 'Active'}</span>
                </div>
                <div class="micro-bar">
                  <div class="micro-fill \${getBarColor(gw.pct)}" style="width: \${gw.pct}%;"></div>
                </div>
              </div>
            </td>
            <td>
              <div class="quota-cell">
                <div class="quota-meta">
                  <span class="quota-pct">\${g5.pct}%</span>
                  <span class="quota-reset">Resets in \${g5.resetText || 'Active'}</span>
                </div>
                <div class="micro-bar">
                  <div class="micro-fill \${getBarColor(g5.pct)}" style="width: \${g5.pct}%;"></div>
                </div>
              </div>
            </td>
            <td>
              <div class="quota-cell">
                <div class="quota-meta">
                  <span class="quota-pct">\${cw.pct}%</span>
                  <span class="quota-reset">Claude / 3P</span>
                </div>
                <div class="micro-bar">
                  <div class="micro-fill \${getBarColor(cw.pct)}" style="width: \${cw.pct}%;"></div>
                </div>
              </div>
            </td>
            <td>
              <div style="display: flex; flex-direction: column; font-size: 11px;">
                <span>\${(a.totalRequests || 0).toLocaleString()} reqs</span>
                <span style="color: var(--text-4);">\${formatNumber(a.totalTokens || 0)} tokens</span>
              </div>
            </td>
            <td style="text-align: right;">
              \${actionBtn}
            </td>
          </tr>
        \`;
      }).join('');
    }

    // Render Accounts Grid View
    function renderAccountsGrid(accounts, data, ideStatus) {
      const grid = document.getElementById('view-grid-wrapper');
      if (!grid) return;

      const activeSessionEmail = (ideStatus?.ideEmail || data.global?.activeSessionEmail || '').toLowerCase();
      const activeSessionId = data.global?.activeSessionAccountId;
      const isGenerating = !!data.global?.isSessionGenerating;
      const pendingEmail = (data.global?.pendingSwitch?.email || '').toLowerCase();

      grid.innerHTML = accounts.map((a, idx) => {
        const isQueued = !!pendingEmail && a.email.toLowerCase() === pendingEmail;
        const isBanned = a.is403Banned;
        const isCooling = a.cooldownUntil && a.cooldownUntil > Date.now();
        const isServing = a.id === activeRunningId;
        const isActive = a.id === activeSessionId || a.email.toLowerCase() === activeSessionEmail;
        const isNextRecommended = !isActive && idx === 1 && !isBanned;
        const isLowest = !isActive && idx === accounts.length - 1 && accounts.length > 2;

        let statusHtml = '<span class="status-badge standby">Standby</span>';
        if (isServing || (isActive && isGenerating)) {
          statusHtml = '<span class="status-badge generating"><span class="pulse-dot" style="background:var(--blue)"></span> Generating</span>';
        } else if (isActive) {
          statusHtml = '<span class="status-badge active-now"><span class="pulse-dot"></span> Active</span>';
        } else if (isQueued) {
          statusHtml = '<span class="status-badge queued">Queued</span>';
        }

        const gw = a.geminiWeekly || { pct: 100, resetText: 'Active' };
        const g5 = a.gemini5h || { pct: 100, resetText: 'Active' };
        const cw = a.claudeWeekly || { pct: 100, resetText: 'Active' };

        const hotkey = idx < 9 ? \`<kbd>\${idx + 1}</kbd>\` : '';

        return \`
          <div class="acc-card \${isActive ? 'is-active' : ''}">
            <div class="acc-card-top">
              <div class="acc-cell">
                <span class="acc-email">\${a.email}</span>
                <span class="acc-name">\${a.name || 'Pro Account'} &bull; \${a.subscriptionTier || 'PRO'}</span>
              </div>
              <div style="display:flex; align-items:center; gap:6px;">
                \${hotkey}
                \${statusHtml}
              </div>
            </div>

            <div class="acc-card-quotas">
              <div class="quota-cell">
                <div class="quota-meta">
                  <span style="color:var(--text-3); font-size:11px;">Gemini Weekly</span>
                  <span class="quota-pct">\${gw.pct}%</span>
                </div>
                <div class="micro-bar">
                  <div class="micro-fill \${getBarColor(gw.pct)}" style="width: \${gw.pct}%;"></div>
                </div>
              </div>

              <div class="quota-cell">
                <div class="quota-meta">
                  <span style="color:var(--text-3); font-size:11px;">5-Hour Burst</span>
                  <span class="quota-pct">\${g5.pct}%</span>
                </div>
                <div class="micro-bar">
                  <div class="micro-fill \${getBarColor(g5.pct)}" style="width: \${g5.pct}%;"></div>
                </div>
              </div>

              <div class="quota-cell">
                <div class="quota-meta">
                  <span style="color:var(--text-3); font-size:11px;">Claude / 3P</span>
                  <span class="quota-pct">\${cw.pct}%</span>
                </div>
                <div class="micro-bar">
                  <div class="micro-fill \${getBarColor(cw.pct)}" style="width: \${cw.pct}%;"></div>
                </div>
              </div>
            </div>

            <div class="acc-card-footer">
              <span>\${(a.totalRequests || 0).toLocaleString()} reqs &bull; \${formatNumber(a.totalTokens || 0)} tokens</span>
              \${!isActive ? \`<button class="btn btn-secondary btn-sm" onclick="setActive('\${a.id}')">Set Active</button>\` : '<span style="color:var(--green); font-weight:500;">Active Now</span>'}
            </div>
          </div>
        \`;
      }).join('');
    }

    // Logging & Actions
    function addLog(msg) {
      const box = document.getElementById('stream-box');
      if (!box) return;
      const time = new Date().toLocaleTimeString();
      const div = document.createElement('div');
      div.className = 'stream-line';
      div.innerHTML = \`<span class="stream-ts">[\${time}]</span> <span>\${msg}</span>\`;
      box.appendChild(div);
      box.scrollTop = box.scrollHeight;
    }

    async function refreshLiveQuotas() {
      if (isSyncing) return;
      isSyncing = true;
      const icon = document.getElementById('sync-icon');
      const text = document.getElementById('sync-text');
      const btn = document.getElementById('btn-sync');

      if (icon) icon.classList.add('spin');
      if (text) text.innerText = 'Syncing...';
      if (btn) btn.disabled = true;
      addLog('🔄 Synchronizing live quota buckets from Google Cloud Code...');

      try {
        await fetch('/api/refresh-quotas', { method: 'POST' });
        addLog('✅ Quotas and reset schedules updated.');
        await fetchMatrix();
      } catch (e) {
        addLog('❌ Failed to refresh quotas: ' + e.message);
      } finally {
        if (icon) icon.classList.remove('spin');
        if (text) text.innerText = 'Sync Quotas';
        if (btn) btn.disabled = false;
        isSyncing = false;
      }
    }

    async function setActive(id) {
      try {
        const res = await fetch(\`/api/set-active-account?id=\${id}\`, { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        const ide = data.ide || {};
        const who = data.email || ide.email || 'selected account';

        if (!res.ok || data.ok === false) {
          addLog(\`⚠️ Could not switch to \${who}: \${data.error || 'unknown error'}\`);
        } else if (ide.restarted || (ide.ok && !ide.deferred && !ide.note)) {
          addLog(\`✅ Switched active account to \${who}.\`);
        } else if (ide.deferred) {
          addLog(\`⏳ Switch queued for \${who}. Will apply once active task finishes.\`);
        } else {
          addLog(\`🔄 Active account set to \${who}.\`);
        }
        await fetchMatrix();
      } catch (e) {
        console.error('Failed to set active account:', e);
      }
    }

    function launchDesktop() {
      fetch('/api/launch-desktop', { method: 'POST' });
      addLog('🚀 Launching Antigravity IDE...');
    }

    async function addAccount() {
      try {
        const tab = window.open('about:blank', '_blank');
        const res = await fetch(\`/api/accounts/login\${tab ? '' : '?open=1'}\`, { method: 'POST' });
        const data = await res.json();
        if (!data.ok) {
          if (tab) tab.close();
          addLog(\`⚠️ Cannot start Google sign-in: \${data.error}\`);
          return;
        }
        if (tab) tab.location.href = data.url;
        addLog('👉 Sign in with your Google account in the newly opened tab.');
      } catch (e) {
        addLog(\`⚠️ Sign-in error: \${e.message}\`);
      }
    }

    async function runProxyTest() {
      const btn = document.getElementById('btn-run-test');
      const btnText = document.getElementById('btn-test-text');
      const box = document.getElementById('test-result-box');
      const statusEl = document.getElementById('test-result-status');
      const metaEl = document.getElementById('test-result-meta');
      const textEl = document.getElementById('test-result-text');

      if (btn) btn.disabled = true;
      if (btnText) btnText.innerText = 'Testing...';
      if (box) box.style.display = 'block';
      if (statusEl) {
        statusEl.innerText = '&bull; Sending request...';
        statusEl.style.color = 'var(--amber)';
      }

      const start = Date.now();
      try {
        const res = await fetch('/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gemini-3.8-flash',
            messages: [{ role: 'user', content: 'Say "Antigravity Gateway is operational" in one brief sentence.' }]
          })
        });
        const elapsed = Date.now() - start;
        const data = await res.json();
        if (res.ok) {
          const content = data.choices?.[0]?.message?.content || JSON.stringify(data);
          statusEl.innerText = \`&bull; \${res.status} OK\`;
          statusEl.style.color = 'var(--green)';
          metaEl.innerText = \`Latency: \${elapsed}ms &bull; Tokens: \${data.usage?.total_tokens || 0}\`;
          textEl.innerText = \`"\${content.trim()}"\`;
        } else {
          statusEl.innerText = \`&bull; \${res.status} Error\`;
          statusEl.style.color = 'var(--red)';
          metaEl.innerText = \`Latency: \${elapsed}ms\`;
          textEl.innerText = data.error?.message || JSON.stringify(data);
        }
      } catch (err) {
        statusEl.innerText = '&bull; Connection Error';
        statusEl.style.color = 'var(--red)';
        metaEl.innerText = \`Failed after \${Date.now() - start}ms\`;
        textEl.innerText = err.message;
      } finally {
        if (btn) btn.disabled = false;
        if (btnText) btnText.innerText = 'Send Test Ping';
        fetchMatrix();
      }
    }

    // Server-Sent Events (SSE) Listener
    try {
      const sse = new EventSource('/api/events');
      sse.onmessage = (e) => {
        try {
          const item = JSON.parse(e.data);
          if (item.type === 'account_active') {
            activeRunningId = item.accountId;
            addLog(\`⚡ \${item.email} is processing request...\`);
            fetchMatrix();
          } else if (item.type === 'account_idle') {
            activeRunningId = null;
            const tok = item.tokens ? \` (+\${item.tokens.total || 0} tokens)\` : '';
            addLog(\`✅ \${item.email} completed prompt in \${item.duration}ms\${tok}\`);
            if (document.getElementById('pane-logs')?.classList.contains('active')) {
              fetchDbLogs();
            }
            fetchMatrix();
          } else if (item.type === 'account_switch') {
            addLog(\`🔄 Session switched to \${item.email}\`);
            fetchMatrix();
          } else if (item.type === 'proactive_switch') {
            addLog(\`🛡️ Proactive switch from \${item.from} to \${item.to}\`);
            fetchMatrix();
          } else if (item.type === 'account_added') {
            addLog(\`✅ Account added: \${item.email}\`);
            fetchMatrix();
          }
        } catch (err) {}
      };
    } catch (e) {}

    // Global Keyboard Shortcuts
    window.addEventListener('keydown', (e) => {
      // Don't trigger if focus is inside an input or textarea
      const tag = document.activeElement?.tagName?.toLowerCase();
      const isInput = tag === 'input' || tag === 'textarea' || tag === 'select';

      if (e.key === 'Escape') {
        closeInspector();
        closeShortcutsModal();
        return;
      }

      if (isInput) return;

      if (e.key === '?') {
        openShortcutsModal();
      } else if (e.key === '/') {
        e.preventDefault();
        switchTab('pane-logs');
        const input = document.getElementById('log-search-input');
        if (input) input.focus();
      } else if (e.key === 'r' || e.key === 'R') {
        refreshLiveQuotas();
      } else if (e.key === 't' || e.key === 'T') {
        setViewMode(currentViewMode === 'table' ? 'grid' : 'table');
      } else if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1;
        if (cachedAccountsList[idx]) {
          setActive(cachedAccountsList[idx].id);
        }
      }
    });

    // Close Modals on Backdrop Click
    document.getElementById('inspector-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'inspector-modal') closeInspector();
    });
    document.getElementById('shortcuts-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'shortcuts-modal') closeShortcutsModal();
    });

    // Init
    setViewMode(currentViewMode);
    fetchSmartShieldConfig();
    const savedTab = localStorage.getItem('harness_active_tab');
    if (savedTab && document.getElementById(savedTab)) {
      switchTab(savedTab);
    } else {
      switchTab('pane-accounts');
    }
    fetchMatrix();
    setInterval(fetchMatrix, 3500);
  </script>
</body>
</html>
`;

fs.writeFileSync(targetPath, htmlContent, 'utf8');
console.log('✅ Successfully compiled modern Vercel/Cloudflare Console redesign to:', targetPath);
