# Workspace navigation

When multiple workspaces are enabled, ordinary same-origin staff links open a
fresh document. This replaces the workspace name, metadata, session providers
and form state together. A shared selection cookie can change in another tab
while localStorage is unavailable; retaining an App Router layout in that case
could present a new workspace's server page under the old workspace's chrome.

WorkspaceBoundary captures only ordinary staff-link clicks. Modified clicks,
new tabs, downloads, local hash links, API-fenced preview controls and non-staff destinations keep native
behavior. Legacy single-workspace navigation keeps its existing client routing.
The cross-tab notice provides hard links for both reload and workspace choice.

Programmatic navigation, debounced filters and refreshes preserve focus and
client transitions by adding the rendered workspace UUID as a `_workspace` URL
expectation. The supported Next Proxy forwards that bounded hint to the page
gate. A mismatched signed selection redirects to the chooser before business
reads; the hint never grants authority.

Full navigation complements API fencing: each staff request carries the
workspace that rendered its form, and a mismatched selection is rejected before
business operations. It adds no polling or global fetch patch. A future move to
workspace-ID route contexts could support fast client navigation with explicit
layout scope.
