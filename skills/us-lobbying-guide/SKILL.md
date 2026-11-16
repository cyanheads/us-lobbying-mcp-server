---
name: us-lobbying-guide
description: Chain uslobbying_* tools through federal lobbying and foreign-agent research — a company's or firm's reported spending by year and issue across the 2008 switch to quarterly reports, who lobbied for a client and what they were paid, a lobbyist's LD-203 reports, FARA checks on a person, and SQL over staged filings. Use when a total must survive amendments, relationship IDs and overlapping issues, or a name match must not become an identity.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Federal disclosures only: LDA registrations and activity reports (LD-2) from 1999, LD-203 contribution reports from 2008, and FARA registrants, foreign principals, short forms and documents. No state lobbying, no FEC campaign-finance records, no corporate identity graph.

Keyless. Anonymous LDA access is paced at 15 requests a minute with 25 records per upstream page; an operator-set `USLOBBYING_LDA_API_KEY` raises the pace to 120. That pace, not the number of tool calls, decides what a question costs (Gate 3). SQL exists only where the deployment enables a canvas (`canvas_available: true` on analytical responses); the `.mcpb` bundle never does.

## Identifiers

| Identifier | Obtain from | Watch for |
|:--|:--|:--|
| Client relationship ID (`client_id`, `client_ids`) | `candidates[].id` from `uslobbying_get_client_profile` resolve mode; `client.id` on any filing | `candidates[].client_id` is a registrant-assigned secondary number the filter does not accept; passing it returns zero rows, not an error. One ID is one registrant–client pair |
| `registrant_id` | `registrant` embedded in candidates, filings and lobbyist identities; `firms[].registrant_id` | LDA only; no FARA crosswalk |
| `lobbyist_id` | `lobbyists[].id` from `uslobbying_search_lobbyists` search mode; `lobbyist.id` in activity lobbyist lists and on LD-203 reports | Each identity row carries its registrant; same-name rows are separate IDs |
| `filing_uuid` | Search, evidence and `selections` rows; `filing_uuids` on `firms`, `clients`, `issue_codes` and `targeted_entities` rows; every staged table | Originals and amendments have distinct UUIDs; UUID order is not amendment lineage |
| Issue, filing-type, state, country, contribution-type codes | `uslobbying_list_reference` topics; `general_issue_code` on activities | Only `source: lda` entries are LDA filter values |
| `registration_number` | `uslobbying_search_foreign_agents` search records | FARA only; links to no LDA ID |
| `canvas_id` and table names | Final analytical windows; table names in `dataset.tables` on the first final window and in `guidance` on each | Each staged scan adds three fresh tables: `raw_filings_…`, `selected_filings_…`, `activities_…` |

## Gates

1. **Take totals from the analytical tools, never from search rows.** `uslobbying_search_filings` returns every version (originals, amendments, registrations), and its `issue_code` matches each version on its own, so summing its amounts double-counts amended periods and keeps issues a later amendment removed. `uslobbying_get_client_profile` profile mode and `uslobbying_get_issue_spending` select the latest posting per registrant, client, year and period first, then apply the issue filter.
2. **A relationship ID is not a company.** Resolve returns one candidate per registrant–client relationship and every name spelling as its own candidate; nothing is merged, and `client_name` is a literal search. Resolve each name the company filed under, page every candidate window, choose by registrant, `general_description` and location, and pass the chosen IDs together as `client_ids`. Report the result as those relationships.
3. **Scope every analytical scan.** An unscoped LDA year is thousands of 25-record pages, hours at the anonymous pace, and a cursor dies 24 hours after its scan started. `uslobbying_get_issue_spending` without `client_id` or `registrant_id` across several years can expire unfinished: scope it, or run one year per scan. Scans never merge; combine their ledgers only across disjoint years or relationships.
4. **Keep a company's expenses apart from its firms' income.** Firms report income from a client; an organization lobbying for itself reports expenses, and those expenses can already include what it paid outside firms. Present the two side by side, never as a sum, and keep `expense_methods` rows apart.
5. **Read each year at its statutory grain.** LD-2 reports are semiannual (`mid_year`, `year_end`) through 2007 and quarterly from 2008. Where a relationship-year filed both grains, the analytics keep the statutory one and exclude the other as `off_cycle_period`; a year that filed one grain keeps it. Compare whole years across 2008, never a half-year with a quarter. Before 2008, statutory activity sits under `mid_year` and `year_end` in `uslobbying_search_filings` too.
6. **Check what a sum left out before presenting it.** Ledgers sum known amounts on unambiguous selected filings only, and an absent sum means no amount was known, not zero. Read the top-level `annual_ledgers` counts (`ambiguous_group_count`, `missing_income_count`, `missing_expense_count`) and the `selections` rows with status `ambiguous` or `excluded`; ledgers on `firms`, `clients` and `issue_codes` rows always report `ambiguous_group_count` 0.
7. **Read issue rows as co-mentions.** With `issue_code` set, every other code's `issue_codes` row covers only filings that also mention the requested code. Without it, each row is that code's whole-filing ledger within the scope.
8. **A missing list is not an empty set.** A final window carries only the row kinds it delivered; `row_set_totals` gives exact counts once acquisition completes. Keep `page_size`, `include` and `row_sets` unchanged for the life of a scan (a change fails `cursor_invalid`); only `max_pages` may differ per call. Retry the previous cursor to replay a lost response.
9. **A name match is not an identity.** Lobbyist activity mode checks only the `lobbyist_id` it is given, so run it once per ID you attribute to a person. A FARA name match says nothing about an LDA lobbyist or registrant with that name.

## Core chain

Company name → `uslobbying_get_client_profile` resolve → choose `candidates[].id` (Gate 2) → profile mode with `client_ids` and explicit `years` → follow `next_cursor` through `status: collecting` and every final window → read ledgers → pass any `filing_uuid` worth quoting to `uslobbying_search_filings`, which returns that filing whole, descriptions and lobbyists included.

## Workflows

**A company's spending on one issue over a span of years.** Choose the relationships (Gate 2), then run profile mode with every chosen ID and every year, `row_sets` limited to `annual_ledgers`, `selections`, `clients` and `issue_codes`. Profile mode has no issue filter: the code's `issue_codes` row is the per-year whole-filing view across those relationships. `uslobbying_get_issue_spending` takes one `client_id`, so for the issue split per relationship call it once per ID with the `issue_code`, or filter in SQL. Report expenses and income separately (Gate 4) and the 2008 change as it is (Gate 5).

**Who lobbied for a client and what they were paid.** Profile mode with `include` naming `activity_lobbyists` on the first call and `row_sets` `clients` and `activities`. Each `clients` row is one relationship with its yearly ledger: a firm's reported income, or the organization's own expenses where it files for itself (Gate 4); `activities` rows list the lobbyists on each activity of the selected filings, with their covered-position text as filed. To follow one person across clients, use `uslobbying_search_lobbyists` activity mode with the `lobbyist_id`, one `filing_year` per call, and optionally the `client_id`.

**A firm's book of business.** `uslobbying_get_issue_spending` with `registrant_id`, `years` and no `issue_code`: its ledgers cover every selected filing of that registrant, `clients` rows split them per client relationship, and `issue_codes` rows give the overlapping per-code view. That tool refuses a `client_id` with neither `issue_code` nor `registrant_id`; profile mode answers one relationship across all issues.

**Bill numbers or topic text.** No analytical tool filters on specific-issues text. `uslobbying_search_filings` with `specific_issues` runs LDA's text search, every version included (Gate 1). It is not an exact bill-number match: `H.R. 1` also returns filings whose only bill is H.R. 1491, so add `activity_descriptions` to `include` and confirm the mention in each description before counting a filing. For amounts, run a scoped profile or registrant scan and match activity descriptions, inline with `include` naming `activity_descriptions` or in SQL on the `activities` table, then total the matching selected filings once each.

**A lobbyist's LD-203 reports.** Take the `lobbyist_id` from `uslobbying_search_lobbyists` search mode, then call `uslobbying_get_contributions` with it and a `filing_year` from 2008 on.

- Originals and amendments arrive as separate reports and nothing links them; never add items across versions of one period. If you settle on one version per period, take the latest `dt_posted`, the rule the LD-2 analytics use, and say that you chose it.
- Total the items `matched_item_indexes` points to, not the whole `contribution_items` list. Report and item counts are batch counts, not donations.
- Contribution types are distinct categories (decode them with topic `contribution_types`); PAC entries record relationships, not who paid each item.

**Is a person a registered foreign agent, and for whom.** `uslobbying_search_foreign_agents` search with entity `short_forms`, the name in `name_contains`, and status `all`, since the default `active` hides terminated filings. Repeat with entity `registrants`, since a name can match there too.

- Take each hit's `registration_number` to detail mode. `foreign_principals` (status `all`) lists the registration's principals and does not say which of them this individual worked for; `documents` rows name either the individual of a Short-Form (`short_form_name`) or the principal a document concerns (`foreign_principal_name`), each with its `document_url`; no row pairs an individual with a principal.
- Search reads a daily snapshot and detail mode reads live. `snapshot_unavailable` is an outage, not zero matches.

**SQL over staged filings.** When `canvas_available` is true, a completed profile or issue scan stages its tables and every final window carries the `canvas_id`. Call `uslobbying_dataframe_describe` with it for the table and column names before writing SQL, then `uslobbying_dataframe_query` with one read-only SELECT. Pass the same `canvas_id` on a later scan's first call to stage its tables beside the first; tables expire at the `expires_at` describe reports.

- `income_usd` and `expenses_usd` are text: sum `CAST(… AS DECIMAL(38,2))`, and NULL stays unknown.
- `selected_filings` already applies the scan's issue filter. In `raw_filings`, `selection_status = 'selected'` marks the version decision made before that filter, beside `superseded`, `ambiguous` and `excluded` rows.
- `activities` has no money column. Joining it to filings repeats each filing once per activity, so filter filings with `EXISTS` on activities rather than summing across a join.
- Group by `filing_year`, not `filing_period`, across 2008 (Gate 5).
