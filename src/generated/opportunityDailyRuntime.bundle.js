var OpportunityDailyRuntime = (function(exports) {
	Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
	//#region src/lib/opportunityStageHistory.ts
	var DEFAULT_OPPORTUNITY_TERMINAL_STAGE_MAP = {
		"100) Closed-Won": "won",
		"Closed-Lost-Competitor": "lost",
		"Closed-Lost-InHouse": "lost",
		"Closed-Disqualified": "disqualified",
		"Closed-Nurture": "nurture"
	};
	var DEFAULT_OPPORTUNITY_OPEN_STAGE_VALUES = [
		"1) Suspect",
		"2) Opportunity Assesment",
		"3) Qualification",
		"4) Discovery",
		"5) Pitching",
		"6) POC",
		"7) Proposal",
		"8) Negotiation",
		"10) Awaiting Execution"
	];
	var DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP = {
		"High Potential Prospect": "hpp",
		High_Potential_Prospect: "hpp",
		Opportunity: "opp",
		Leads: "opp",
		"Sales Accepted Opportunity": "opp",
		Pursuit: "pursuit",
		Licensing: "pursuit",
		"Sales Qualified Opportunity": "pursuit",
		Nurture: "out_of_scope",
		Service: "out_of_scope"
	};
	var STAGE_RANK = {
		hpp: 1,
		opp: 2,
		pursuit: 3
	};
	var FUNNEL_STAGES = [
		"hpp",
		"opp",
		"pursuit"
	];
	var LEGAL_RECORD_TYPE_STATES = new Set([
		"hpp",
		"opp",
		"pursuit",
		"out_of_scope"
	]);
	var LEGAL_TERMINAL_STATES = new Set([
		"won",
		"lost",
		"disqualified",
		"nurture"
	]);
	var TIME_PART = /^T([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
	var DATE_PART = /^(\d{4})-(\d{2})-(\d{2})$/;
	function daysInMonth(year, month) {
		return new Date(Date.UTC(year, month, 0)).getUTCDate();
	}
	function isValidCalendarDate(value) {
		const m = DATE_PART.exec(value);
		if (!m) return false;
		const year = Number(m[1]);
		const month = Number(m[2]);
		const day = Number(m[3]);
		if (year < 1900 || year > 2200) return false;
		if (month < 1 || month > 12) return false;
		return day >= 1 && day <= daysInMonth(year, month);
	}
	function isValidHistoryTimestamp(value) {
		if (!isValidCalendarDate(value.slice(0, 10))) return false;
		const rest = value.slice(10);
		return rest === "" || TIME_PART.test(rest);
	}
	function sameRowContent(a, b) {
		return a.opportunityId === b.opportunityId && a.field === b.field && a.oldValue === b.oldValue && a.newValue === b.newValue && a.changedAt === b.changedAt;
	}
	function diffDays(fromIso, toIso) {
		const from = Date.UTC(Number(fromIso.slice(0, 4)), Number(fromIso.slice(5, 7)) - 1, Number(fromIso.slice(8, 10)));
		const to = Date.UTC(Number(toIso.slice(0, 4)), Number(toIso.slice(5, 7)) - 1, Number(toIso.slice(8, 10)));
		return Math.round((to - from) / 864e5);
	}
	function pushIssue(issues, kind, count = 1) {
		const found = issues.find((i) => i.kind === kind);
		if (found) found.count += count;
		else issues.push({
			kind,
			count
		});
	}
	function mapRecordType(value, config) {
		if (value === null || value.trim() === "") return { kind: "blank" };
		const mapped = config.recordTypeMap[value.trim()];
		if (mapped === void 0) return { kind: "unknown" };
		return {
			kind: "state",
			state: mapped
		};
	}
	function mapStageValue(value, config) {
		if (value === null || value.trim() === "") return { kind: "blank" };
		const v = value.trim();
		const terminal = config.terminalStageMap?.[v];
		if (terminal !== void 0) return {
			kind: "terminal",
			status: terminal
		};
		if (config.openStageValues?.includes(v)) return { kind: "open" };
		return { kind: "unknown" };
	}
	function applyPathStep(sim, fromState, toState, day) {
		const next = {
			state: toState,
			dates: { ...sim.dates }
		};
		if (toState === "hpp" || toState === "opp" || toState === "pursuit") {
			const toRank = STAGE_RANK[toState];
			const fromRank = fromState === "hpp" || fromState === "opp" || fromState === "pursuit" ? STAGE_RANK[fromState] : null;
			if (fromRank !== null && fromRank < toRank) {
				for (const s of FUNNEL_STAGES) if (STAGE_RANK[s] > fromRank && STAGE_RANK[s] <= toRank) next.dates[s] = day;
			} else next.dates[toState] = day;
			for (const s of FUNNEL_STAGES) if (STAGE_RANK[s] > toRank) next.dates[s] = null;
		}
		return next;
	}
	function samePathSim(a, b) {
		return a.state === b.state && a.dates.hpp === b.dates.hpp && a.dates.opp === b.dates.opp && a.dates.pursuit === b.dates.pursuit;
	}
	function permutations(items) {
		if (items.length <= 1) return [items];
		const out = [];
		for (let i = 0; i < items.length; i += 1) {
			const rest = [...items.slice(0, i), ...items.slice(i + 1)];
			for (const p of permutations(rest)) out.push([items[i], ...p]);
		}
		return out;
	}
	function adaptOpportunityHistory(rows, config, baselines = []) {
		const issues = [];
		const review = [];
		const invalidResult = () => ({
			state: "invalid",
			opportunities: [],
			ledger: [],
			terminalLedger: [],
			review,
			duplicatesIgnored: 0,
			otherFieldRowsIgnored: 0,
			issues: [{
				kind: "invalid_config",
				count: 1
			}]
		});
		if (!config.recordTypeFieldName.trim()) return invalidResult();
		const mapEntries = Object.entries(config.recordTypeMap);
		if (mapEntries.length === 0) return invalidResult();
		for (const [key, state] of mapEntries) if (!key.trim() || !LEGAL_RECORD_TYPE_STATES.has(state)) return invalidResult();
		if (config.terminalStageMap) {
			for (const [key, state] of Object.entries(config.terminalStageMap)) if (!key.trim() || !LEGAL_TERMINAL_STATES.has(state)) return invalidResult();
		}
		if (config.openStageValues) {
			for (const v of config.openStageValues) if (!v.trim() || config.terminalStageMap?.[v.trim()] !== void 0) return invalidResult();
		}
		const wellFormed = [];
		for (const row of rows) {
			if (!row.historyId.trim() || !row.opportunityId.trim()) {
				pushIssue(issues, "invalid_source_row");
				review.push({
					reason: "invalid_source_row",
					historyId: row.historyId.trim() || void 0
				});
				continue;
			}
			if (!isValidHistoryTimestamp(row.changedAt)) {
				pushIssue(issues, "invalid_history_timestamp");
				review.push({
					reason: "invalid_history_timestamp",
					historyId: row.historyId
				});
				continue;
			}
			wellFormed.push(row);
		}
		const byId = /* @__PURE__ */ new Map();
		for (const row of wellFormed) {
			if (!byId.has(row.historyId)) byId.set(row.historyId, []);
			byId.get(row.historyId).push(row);
		}
		let duplicatesIgnored = 0;
		const unique = [];
		for (const [historyId, group] of byId) {
			const first = group[0];
			if (!group.every((r) => sameRowContent(r, first))) {
				pushIssue(issues, "conflicting_duplicate_history_id");
				review.push({
					reason: "conflicting_duplicate_history_id",
					historyId,
					opportunityId: first.opportunityId
				});
				continue;
			}
			duplicatesIgnored += group.length - 1;
			unique.push(first);
		}
		let otherFieldRowsIgnored = 0;
		const recordTypeRows = /* @__PURE__ */ new Map();
		const stageRows = /* @__PURE__ */ new Map();
		for (const row of unique) if (row.field === config.recordTypeFieldName) {
			if (!recordTypeRows.has(row.opportunityId)) recordTypeRows.set(row.opportunityId, []);
			recordTypeRows.get(row.opportunityId).push(row);
		} else if (config.stageFieldName && row.field === config.stageFieldName) {
			if (!stageRows.has(row.opportunityId)) stageRows.set(row.opportunityId, []);
			stageRows.get(row.opportunityId).push(row);
		} else otherFieldRowsIgnored += 1;
		const ordered = (list) => [...list].sort((a, b) => {
			if (a.changedAt < b.changedAt) return -1;
			if (a.changedAt > b.changedAt) return 1;
			return a.historyId < b.historyId ? -1 : a.historyId > b.historyId ? 1 : 0;
		});
		const oppIds = new Set([...recordTypeRows.keys(), ...stageRows.keys()]);
		const applicableBaselines = baselines.filter((b) => !recordTypeRows.has(b.opportunityId));
		for (const b of applicableBaselines) oppIds.add(b.opportunityId);
		const ledger = [];
		const terminalLedger = [];
		const opportunities = [];
		for (const opportunityId of oppIds) {
			const oppIssues = [];
			const activeDates = {
				hpp: null,
				opp: null,
				pursuit: null
			};
			const entries = {
				hpp: 0,
				opp: 0,
				pursuit: 0
			};
			let currentState = null;
			let forwardMoves = 0;
			let backwardMoves = 0;
			let forwardSkips = 0;
			let backwardSkips = 0;
			let incompleteBaseline = false;
			let blocked = false;
			const baseline = applicableBaselines.find((b) => b.opportunityId === opportunityId);
			if (baseline) {
				const mapped = mapRecordType(baseline.recordTypeValue, config);
				const toState = mapped.kind === "state" ? mapped.state : "unknown";
				if (mapped.kind !== "state") {
					pushIssue(oppIssues, "unknown_record_type");
					review.push({
						reason: "unknown_record_type",
						opportunityId,
						historyId: baseline.sourceId
					});
					blocked = true;
				}
				ledger.push({
					sourceHistoryId: baseline.sourceId,
					salesforceOpportunityId: opportunityId,
					fromState: null,
					toState,
					changedAt: baseline.observedAt,
					source: "baseline_observation",
					baselineObservation: true,
					historyKnownBefore: false,
					rawRecordType: {
						oldValue: null,
						newValue: baseline.recordTypeValue
					}
				});
				currentState = toState;
				incompleteBaseline = true;
				if (toState === "hpp" || toState === "opp" || toState === "pursuit") entries[toState] += 1;
			}
			const steps = [];
			let firstHistoryEvent = true;
			for (const row of ordered(recordTypeRows.get(opportunityId) ?? [])) {
				const oldMapped = mapRecordType(row.oldValue, config);
				const newMapped = mapRecordType(row.newValue, config);
				const fromState = oldMapped.kind === "state" ? oldMapped.state : oldMapped.kind === "unknown" ? "unknown" : null;
				const toState = newMapped.kind === "state" ? newMapped.state : "unknown";
				if (newMapped.kind === "blank") {
					pushIssue(oppIssues, "invalid_source_row");
					review.push({
						reason: "invalid_source_row",
						historyId: row.historyId,
						opportunityId
					});
					continue;
				}
				if (newMapped.kind === "unknown" || oldMapped.kind === "unknown") {
					pushIssue(oppIssues, "unknown_record_type");
					review.push({
						reason: "unknown_record_type",
						historyId: row.historyId,
						opportunityId
					});
					blocked = true;
				}
				const historyKnownBefore = !firstHistoryEvent || oldMapped.kind === "blank";
				if (firstHistoryEvent && oldMapped.kind !== "blank") incompleteBaseline = true;
				firstHistoryEvent = false;
				ledger.push({
					sourceHistoryId: row.historyId,
					salesforceOpportunityId: opportunityId,
					fromState,
					toState,
					changedAt: row.changedAt,
					source: "salesforce_history",
					baselineObservation: false,
					historyKnownBefore,
					rawRecordType: {
						oldValue: row.oldValue,
						newValue: row.newValue
					}
				});
				const fromRank = fromState && fromState !== "out_of_scope" && fromState !== "unknown" ? STAGE_RANK[fromState] : null;
				const toRank = toState !== "out_of_scope" && toState !== "unknown" ? STAGE_RANK[toState] : null;
				if (fromRank !== null && toRank !== null) {
					const delta = toRank - fromRank;
					if (delta > 0) {
						forwardMoves += 1;
						if (delta === 2) forwardSkips += 1;
					} else if (delta < 0) {
						backwardMoves += 1;
						if (delta === -2) backwardSkips += 1;
					}
				}
				if (toRank !== null) if (fromRank !== null && fromRank < toRank) {
					for (const s of FUNNEL_STAGES) if (STAGE_RANK[s] > fromRank && STAGE_RANK[s] <= toRank) entries[s] += 1;
				} else entries[toState] += 1;
				steps.push({
					row,
					fromState,
					toState
				});
			}
			let sim = {
				state: currentState,
				dates: { ...activeDates }
			};
			let index = 0;
			while (index < steps.length) {
				const group = [steps[index]];
				let next = index + 1;
				while (next < steps.length && steps[next].row.changedAt === steps[index].row.changedAt) {
					group.push(steps[next]);
					next += 1;
				}
				const day = group[0].row.changedAt.slice(0, 10);
				if (group.length === 1) sim = applyPathStep(sim, group[0].fromState, group[0].toState, day);
				else {
					const run = (perm) => perm.reduce((acc, st) => applyPathStep(acc, st.fromState, st.toState, day), sim);
					const allAgree = (perms) => {
						const outcomes = perms.map(run);
						return outcomes.every((o) => samePathSim(o, outcomes[0])) ? outcomes[0] : null;
					};
					let resolved = null;
					if (group.length <= 4) {
						const chained = permutations(group).filter((perm) => {
							let state = sim.state;
							for (const st of perm) {
								if (st.fromState === null) {
									if (state !== null) return false;
								} else if (st.fromState !== "unknown" && state !== null && st.fromState !== state) return false;
								state = st.toState;
							}
							return true;
						});
						if (chained.length > 0) resolved = allAgree(chained);
						if (resolved === null) resolved = allAgree(permutations(group));
					}
					if (resolved === null) {
						pushIssue(oppIssues, "ambiguous_same_timestamp");
						review.push({
							reason: "ambiguous_same_timestamp",
							opportunityId,
							historyId: group[0].row.historyId
						});
						const outcomes = permutations(group.slice(0, 4)).map(run);
						if (new Set(outcomes.map((o) => o.state)).size === 1) {
							const dates = {
								hpp: null,
								opp: null,
								pursuit: null
							};
							for (const s of FUNNEL_STAGES) dates[s] = new Set(outcomes.map((o) => o.dates[s])).size === 1 ? outcomes[0].dates[s] : null;
							resolved = {
								state: outcomes[0].state,
								dates
							};
						} else {
							blocked = true;
							resolved = {
								state: "unknown",
								dates: {
									hpp: null,
									opp: null,
									pursuit: null
								}
							};
						}
					}
					sim = resolved;
				}
				index = next;
			}
			currentState = sim.state;
			activeDates.hpp = sim.dates.hpp;
			activeDates.opp = sim.dates.opp;
			activeDates.pursuit = sim.dates.pursuit;
			let terminalStatus = "unknown";
			const oppStageRows = ordered(stageRows.get(opportunityId) ?? []);
			if (oppStageRows.length > 0) {
				terminalStatus = "open";
				for (const row of oppStageRows) {
					const oldStage = mapStageValue(row.oldValue, config);
					const newStage = mapStageValue(row.newValue, config);
					if (newStage.kind === "unknown" || newStage.kind === "blank") {
						pushIssue(oppIssues, "unknown_stage_value");
						review.push({
							reason: "unknown_stage_value",
							historyId: row.historyId,
							opportunityId
						});
						continue;
					}
					const toStatus = newStage.kind === "terminal" ? newStage.status : "open";
					const fromStatus = oldStage.kind === "terminal" ? oldStage.status : oldStage.kind === "unknown" ? "unknown" : "open";
					if (fromStatus === toStatus) continue;
					terminalLedger.push({
						sourceHistoryId: row.historyId,
						salesforceOpportunityId: opportunityId,
						fromStatus,
						toStatus,
						changedAt: row.changedAt,
						rawStage: {
							oldValue: row.oldValue,
							newValue: row.newValue
						}
					});
					terminalStatus = toStatus;
				}
			}
			if (incompleteBaseline) pushIssue(oppIssues, "incomplete_baseline");
			const velocity = {
				hppToOppDays: null,
				oppToPursuitDays: null,
				hppToPursuitDays: null
			};
			const { hpp, opp, pursuit } = activeDates;
			const interval = (from, to) => {
				if (!from || !to) return null;
				const d = diffDays(from, to);
				if (d < 0) {
					pushIssue(oppIssues, "inconsistent_path_dates");
					return null;
				}
				return d;
			};
			velocity.hppToOppDays = interval(hpp, opp);
			velocity.oppToPursuitDays = interval(opp, pursuit);
			if (opp === null) velocity.hppToPursuitDays = interval(hpp, pursuit);
			const currentStage = currentState === "hpp" || currentState === "opp" || currentState === "pursuit" ? currentState : null;
			for (const i of oppIssues) pushIssue(issues, i.kind, i.count);
			opportunities.push({
				opportunityId,
				currentStage,
				currentState,
				activeDates,
				terminalStatus,
				forwardMoves,
				backwardMoves,
				skips: {
					forward: forwardSkips,
					backward: backwardSkips
				},
				reEntries: {
					hpp: Math.max(0, entries.hpp - 1),
					opp: Math.max(0, entries.opp - 1),
					pursuit: Math.max(0, entries.pursuit - 1)
				},
				incompleteBaseline,
				velocity,
				issues: oppIssues,
				reportable: !blocked && currentState !== null && currentState !== "unknown"
			});
		}
		let state = "complete";
		if (opportunities.length === 0 && review.length === 0) state = "missing";
		else if (review.length > 0 || issues.length > 0) state = "incomplete";
		return {
			state,
			opportunities,
			ledger,
			terminalLedger,
			review,
			duplicatesIgnored,
			otherFieldRowsIgnored,
			issues
		};
	}
	//#endregion
	//#region src/lib/opportunityImportStorage.ts
	function canonicalEventTimestamp(value) {
		const millis = Date.parse(value);
		return Number.isFinite(millis) ? new Date(millis).toISOString() : value;
	}
	function classifyIncomingEvent(stored, incoming) {
		if (!stored) return "new";
		return stored.sfOpportunityId === incoming.sfOpportunityId && stored.sourceField === incoming.sourceField && stored.oldValue === incoming.oldValue && stored.newValue === incoming.newValue && canonicalEventTimestamp(stored.changedAt) === canonicalEventTimestamp(incoming.changedAt) ? "exact_duplicate" : "conflict";
	}
	function buildRecordTypeEventInsert(event, sourceField) {
		return {
			sf_opportunity_id: event.salesforceOpportunityId,
			sf_history_id: event.sourceHistoryId,
			source_field: sourceField,
			old_value: event.rawRecordType?.oldValue ?? null,
			new_value: event.rawRecordType?.newValue ?? null,
			event_kind: "record_type",
			from_record_type_state: event.fromState,
			to_record_type_state: event.toState,
			from_terminal_state: null,
			to_terminal_state: null,
			changed_at: event.changedAt
		};
	}
	function buildTerminalEventInsert(event, sourceField) {
		return {
			sf_opportunity_id: event.salesforceOpportunityId,
			sf_history_id: event.sourceHistoryId,
			source_field: sourceField,
			old_value: event.rawStage.oldValue,
			new_value: event.rawStage.newValue,
			event_kind: "stage",
			from_record_type_state: null,
			to_record_type_state: null,
			from_terminal_state: event.fromStatus,
			to_terminal_state: event.toStatus,
			changed_at: event.changedAt
		};
	}
	function auditEvent(type, previous, next, codes, ctx, evidence = {}) {
		return {
			event_type: type,
			previous_state: previous,
			new_state: next,
			issue_codes_snapshot: [...codes].sort(),
			actor_type: ctx.actorType,
			actor_id: ctx.actorId ?? null,
			note: ctx.note ?? null,
			sf_history_id: evidence.sf_history_id ?? null,
			accepted_content_hash: evidence.accepted_content_hash ?? null,
			conflicting_content_hash: evidence.conflicting_content_hash ?? null,
			dedupe_key: evidence.dedupe_key ?? null,
			occurred_at: ctx.occurredAt
		};
	}
	function createReviewMutation(seed, ctx) {
		return {
			projection: {
				reviewState: seed.review_state,
				issueCodes: seed.issue_codes,
				channelId: seed.channel_id,
				leadId: seed.lead_id
			},
			auditEvent: auditEvent("review_created", null, "pending", seed.issue_codes, ctx)
		};
	}
	function recordIngestionConflict(current, evidence, ctx) {
		const codes = current.issueCodes.includes("conflicting_history_id") ? current.issueCodes : [...current.issueCodes, "conflicting_history_id"];
		return {
			projection: {
				...current,
				issueCodes: codes
			},
			auditEvent: auditEvent("conflict_observed", null, null, codes, ctx, {
				sf_history_id: evidence.sfHistoryId,
				accepted_content_hash: evidence.acceptedContentHash,
				conflicting_content_hash: evidence.conflictingContentHash,
				dedupe_key: `conflict:${evidence.sfHistoryId}:${evidence.conflictingContentHash}`
			})
		};
	}
	function buildReviewSeed(derived, snapshot, resultReview = []) {
		const codes = new Set(["missing_channel"]);
		if (!snapshot.commercialRegion || !snapshot.commercialRegion.trim()) codes.add("missing_region");
		for (const issue of derived.issues) {
			if (issue.kind === "unknown_record_type") codes.add("unknown_record_type");
			if (issue.kind === "ambiguous_same_timestamp") codes.add("ambiguous_same_timestamp");
			if (issue.kind === "incomplete_baseline") codes.add("incomplete_history");
			if (issue.kind === "invalid_source_row") codes.add("invalid_source_row");
		}
		for (const item of resultReview) {
			if (item.opportunityId !== derived.opportunityId) continue;
			if (item.reason === "conflicting_duplicate_history_id") codes.add("conflicting_history_id");
			if (item.reason === "unknown_stage_value") codes.add("unknown_stage_value");
			if (item.reason === "invalid_source_row") codes.add("invalid_source_row");
		}
		return {
			sf_opportunity_id: derived.opportunityId,
			review_state: "pending",
			issue_codes: [...codes].sort(),
			channel_id: null,
			lead_id: null
		};
	}
	//#endregion
	//#region src/lib/salesforceOpportunitySync.ts
	var LEGACY_TERMINAL_STAGE_ALIASES = {
		"0. Recycle/Nurture": "nurture",
		"Recycle / Nurture": "nurture",
		"0) Recycle / Nurture": "nurture",
		"Close-Lost-No Decision": "lost",
		"Close-No Decision": "lost",
		"Closed-Won": "won",
		"9) Closed-Won": "won",
		"CP DQ - Project Cancelled": "disqualified"
	};
	var LEGACY_OPEN_STAGE_ALIASES = [
		"Suspect",
		"1. Suspect",
		"Opportunity Assessment",
		"2. Opportunity Assessment",
		"Qualification",
		"1) Qualification",
		"Demo / Oral Presentations",
		"Pitching",
		"3) Pitching",
		"Proposal",
		"Discovery",
		"2) Discovery",
		"Initial Proposal / Term Sheet",
		"Proof of Concept",
		"Negotiation",
		"Risk Assessment",
		"4.1) Pursuit Evaluation",
		"9) Contract Agreement",
		"Contract Agreement / Awaiting Execution",
		"Awaiting Execution",
		"Contract Creation",
		"Contract Agreement",
		"7) Contract Agreement"
	];
	var ZERO_WIDTH = /\u200B|\u200C|\u200D|\uFEFF/g;
	function normalizeSourceValue(value) {
		if (value === null) return null;
		const cleaned = value.replace(ZERO_WIDTH, "").trim();
		return cleaned === "" ? null : cleaned;
	}
	var DRY_RUN_STAGE_CONFIG = {
		recordTypeFieldName: "RecordType",
		recordTypeMap: DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP,
		stageFieldName: "StageName",
		terminalStageMap: {
			...DEFAULT_OPPORTUNITY_TERMINAL_STAGE_MAP,
			...LEGACY_TERMINAL_STAGE_ALIASES
		},
		openStageValues: [...DEFAULT_OPPORTUNITY_OPEN_STAGE_VALUES, ...LEGACY_OPEN_STAGE_ALIASES]
	};
	var INDUSTRY_VERTICAL_CANDIDATES = [
		"Insurance_vertical__c",
		"Industry_Vertical__c",
		"Pursuit_Industry_Vertical__c"
	];
	function mapHistoryRecord(rec) {
		return {
			historyId: rec.Id,
			opportunityId: rec.OpportunityId,
			field: rec.Field,
			oldValue: rec.OldValue ?? null,
			newValue: rec.NewValue ?? null,
			changedAt: rec.CreatedDate
		};
	}
	function mapBaselineObservation(rec, observedAt) {
		return {
			opportunityId: rec.Id,
			recordTypeValue: rec.RecordType?.DeveloperName ?? "",
			observedAt,
			sourceId: `baseline:${rec.Id}`
		};
	}
	function buildRecordTypeIdMap(refs) {
		const map = {};
		for (const ref of refs) {
			if (!ref.Id?.trim() || !ref.DeveloperName?.trim()) continue;
			const entry = {
				developerName: ref.DeveloperName.trim(),
				name: (ref.Name ?? ref.DeveloperName).trim(),
				isOpportunityType: (ref.SobjectType ?? "").trim() === "Opportunity"
			};
			map[ref.Id.trim()] = entry;
			if (ref.Id.trim().length === 18) map[ref.Id.trim().slice(0, 15)] = entry;
		}
		return map;
	}
	var SFDC_ID_SHAPE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;
	function resolveRecordTypeValue(raw, idMap) {
		const v = normalizeSourceValue(raw);
		if (v === null) return { kind: "blank" };
		const viaId = idMap[v];
		if (viaId !== void 0) return {
			kind: "resolved_via_id_map",
			value: viaId.developerName,
			ref: viaId
		};
		if (DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP[v] !== void 0) return {
			kind: "resolved_known_value",
			value: v
		};
		if (SFDC_ID_SHAPE.test(v)) return {
			kind: "unresolved_id_shaped",
			value: v
		};
		return {
			kind: "unmapped_label",
			value: v
		};
	}
	function assertUniqueSourceIds(ids, label) {
		const seen = /* @__PURE__ */ new Set();
		for (const raw of ids) {
			const id = (raw ?? "").trim();
			if (!id) continue;
			if (seen.has(id)) throw new Error(`query amplification: duplicate ${label} Id in query output; a global query executed more than once per run`);
			seen.add(id);
		}
	}
	function prepareHistoryRows(historyRecords, recordTypeRefs) {
		assertUniqueSourceIds(recordTypeRefs.map((r) => r.Id), "RecordType");
		const idMap = buildRecordTypeIdMap(recordTypeRefs);
		const rtValueCounts = {
			resolvedViaIdMap: 0,
			resolvedAsKnownValue: 0,
			blankBaseline: 0,
			unresolvedIdShaped: 0,
			unmappedNonblankLabel: 0,
			affectedRows: 0
		};
		const unmappedRecordTypes = /* @__PURE__ */ new Map();
		const noteUnmapped = (key, entry, side) => {
			const d = unmappedRecordTypes.get(key) ?? {
				...entry,
				occurrences: 0,
				old: false,
				new: false
			};
			d.occurrences += 1;
			d[side] = true;
			unmappedRecordTypes.set(key, d);
		};
		const resolveSide = (raw, side) => {
			const r = resolveRecordTypeValue(raw, idMap);
			switch (r.kind) {
				case "blank":
					rtValueCounts.blankBaseline += 1;
					return null;
				case "resolved_via_id_map":
					rtValueCounts.resolvedViaIdMap += 1;
					if (DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP[r.value] === void 0) noteUnmapped(r.ref.developerName, {
						name: r.ref.name,
						developerName: r.ref.developerName,
						confirmedOpportunityType: r.ref.isOpportunityType
					}, side);
					return r.value;
				case "resolved_known_value":
					rtValueCounts.resolvedAsKnownValue += 1;
					return r.value;
				case "unresolved_id_shaped":
					rtValueCounts.unresolvedIdShaped += 1;
					return r.value;
				case "unmapped_label":
					rtValueCounts.unmappedNonblankLabel += 1;
					noteUnmapped(r.value, {
						name: r.value,
						developerName: null,
						confirmedOpportunityType: false
					}, side);
					return r.value;
			}
		};
		const resolvedRows = historyRecords.map((rec) => {
			const mapped = mapHistoryRecord(rec);
			if (mapped.field === DRY_RUN_STAGE_CONFIG.stageFieldName) return {
				...mapped,
				oldValue: normalizeSourceValue(mapped.oldValue),
				newValue: normalizeSourceValue(mapped.newValue)
			};
			if (mapped.field !== DRY_RUN_STAGE_CONFIG.recordTypeFieldName) return mapped;
			const before = rtValueCounts.unresolvedIdShaped + rtValueCounts.unmappedNonblankLabel;
			const oldValue = resolveSide(mapped.oldValue, "old");
			const newValue = resolveSide(mapped.newValue, "new");
			if (rtValueCounts.unresolvedIdShaped + rtValueCounts.unmappedNonblankLabel > before) rtValueCounts.affectedRows += 1;
			return {
				...mapped,
				oldValue,
				newValue
			};
		});
		const funnelKey = (v) => v === null ? "" : DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP[v] ?? `raw:${v}`;
		const seenTransitions = /* @__PURE__ */ new Set();
		const seenHistoryIds = /* @__PURE__ */ new Set();
		let pairedRecordTypeRepresentationRows = 0;
		return {
			rows: resolvedRows.filter((row) => {
				if (row.field !== DRY_RUN_STAGE_CONFIG.recordTypeFieldName) return true;
				if (seenHistoryIds.has(row.historyId)) return true;
				seenHistoryIds.add(row.historyId);
				const key = [
					row.opportunityId,
					row.changedAt,
					funnelKey(row.oldValue),
					funnelKey(row.newValue)
				].join("|");
				if (seenTransitions.has(key)) {
					pairedRecordTypeRepresentationRows += 1;
					return false;
				}
				seenTransitions.add(key);
				return true;
			}),
			rtValueCounts,
			unmappedRecordTypes: [...unmappedRecordTypes.values()].map((d) => ({
				name: d.name,
				developerName: d.developerName,
				occurrences: d.occurrences,
				seenAs: d.old && d.new ? "both" : d.old ? "old" : "new",
				confirmedOpportunityType: d.confirmedOpportunityType
			})).sort((a, b) => b.occurrences - a.occurrences || a.name.localeCompare(b.name)),
			pairedRecordTypeRepresentationRows
		};
	}
	//#endregion
	//#region src/lib/sha256.ts
	var K = [
		1116352408,
		1899447441,
		3049323471,
		3921009573,
		961987163,
		1508970993,
		2453635748,
		2870763221,
		3624381080,
		310598401,
		607225278,
		1426881987,
		1925078388,
		2162078206,
		2614888103,
		3248222580,
		3835390401,
		4022224774,
		264347078,
		604807628,
		770255983,
		1249150122,
		1555081692,
		1996064986,
		2554220882,
		2821834349,
		2952996808,
		3210313671,
		3336571891,
		3584528711,
		113926993,
		338241895,
		666307205,
		773529912,
		1294757372,
		1396182291,
		1695183700,
		1986661051,
		2177026350,
		2456956037,
		2730485921,
		2820302411,
		3259730800,
		3345764771,
		3516065817,
		3600352804,
		4094571909,
		275423344,
		430227734,
		506948616,
		659060556,
		883997877,
		958139571,
		1322822218,
		1537002063,
		1747873779,
		1955562222,
		2024104815,
		2227730452,
		2361852424,
		2428436474,
		2756734187,
		3204031479,
		3329325298
	];
	function rotr(x, n) {
		return x >>> n | x << 32 - n;
	}
	function sha256Hex(input) {
		const bytes = [];
		for (let i = 0; i < input.length; i += 1) {
			let code = input.charCodeAt(i);
			if (code < 128) bytes.push(code);
			else if (code < 2048) bytes.push(192 | code >> 6, 128 | code & 63);
			else if (code >= 55296 && code <= 56319 && i + 1 < input.length) {
				const next = input.charCodeAt(i + 1);
				if (next >= 56320 && next <= 57343) {
					code = 65536 + (code - 55296 << 10) + (next - 56320);
					bytes.push(240 | code >> 18, 128 | code >> 12 & 63, 128 | code >> 6 & 63, 128 | code & 63);
					i += 1;
				} else bytes.push(224 | code >> 12, 128 | code >> 6 & 63, 128 | code & 63);
			} else bytes.push(224 | code >> 12, 128 | code >> 6 & 63, 128 | code & 63);
		}
		const bitLen = bytes.length * 8;
		bytes.push(128);
		while (bytes.length % 64 !== 56) bytes.push(0);
		bytes.push(0, 0, 0, 0, bitLen >>> 24 & 255, bitLen >>> 16 & 255, bitLen >>> 8 & 255, bitLen & 255);
		let h0 = 1779033703;
		let h1 = 3144134277;
		let h2 = 1013904242;
		let h3 = 2773480762;
		let h4 = 1359893119;
		let h5 = 2600822924;
		let h6 = 528734635;
		let h7 = 1541459225;
		const w = new Array(64);
		for (let offset = 0; offset < bytes.length; offset += 64) {
			for (let t = 0; t < 16; t += 1) {
				const i = offset + t * 4;
				w[t] = (bytes[i] << 24 | bytes[i + 1] << 16 | bytes[i + 2] << 8 | bytes[i + 3]) >>> 0;
			}
			for (let t = 16; t < 64; t += 1) {
				const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ w[t - 15] >>> 3;
				const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ w[t - 2] >>> 10;
				w[t] = w[t - 16] + s0 + w[t - 7] + s1 >>> 0;
			}
			let a = h0;
			let b = h1;
			let c = h2;
			let d = h3;
			let e = h4;
			let f = h5;
			let g = h6;
			let h = h7;
			for (let t = 0; t < 64; t += 1) {
				const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
				const ch = e & f ^ ~e & g;
				const temp1 = h + S1 + ch + K[t] + w[t] >>> 0;
				const temp2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + (a & b ^ a & c ^ b & c) >>> 0;
				h = g;
				g = f;
				f = e;
				e = d + temp1 >>> 0;
				d = c;
				c = b;
				b = a;
				a = temp1 + temp2 >>> 0;
			}
			h0 = h0 + a >>> 0;
			h1 = h1 + b >>> 0;
			h2 = h2 + c >>> 0;
			h3 = h3 + d >>> 0;
			h4 = h4 + e >>> 0;
			h5 = h5 + f >>> 0;
			h6 = h6 + g >>> 0;
			h7 = h7 + h >>> 0;
		}
		return [
			h0,
			h1,
			h2,
			h3,
			h4,
			h5,
			h6,
			h7
		].map((x) => x.toString(16).padStart(8, "0")).join("");
	}
	//#endregion
	//#region src/lib/opportunityIngestionPlanner.ts
	var str = (v) => normalizeSourceValue(typeof v === "string" ? v : null);
	var num = (v) => typeof v === "number" && Number.isFinite(v) ? v : null;
	function normalizedRecordTypeState(rec) {
		const dev = normalizeSourceValue(rec.RecordType?.DeveloperName ?? null);
		if (dev === null) return "unknown";
		return DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP[dev] ?? "unknown";
	}
	function suggestedBdrName(rec) {
		const creator = str(rec.CreatedBy?.Name);
		if (creator === "Dave Cummins" || creator === "David Cummins") return "Dave Cummins";
		if (creator === "Garrett McNally") return "Garrett McNally";
		return null;
	}
	function parseSourceInstant(value) {
		if (value === null) return null;
		const ms = Date.parse(value);
		return Number.isFinite(ms) ? ms : null;
	}
	function buildSnapshotPayload(rec) {
		const modstampRaw = str(rec.SystemModstamp) ?? str(rec.LastModifiedDate);
		const modstampMs = parseSourceInstant(modstampRaw);
		if (modstampRaw === null || modstampMs === null) throw new Error("snapshot validation: missing or unparseable source SystemModstamp/LastModifiedDate");
		const modstamp = new Date(modstampMs).toISOString();
		const withoutHash = {
			sf_opportunity_id: rec.Id,
			record_type_developer_name: str(rec.RecordType?.DeveloperName),
			record_type_label: str(rec.RecordType?.Name),
			normalized_record_type_state: normalizedRecordTypeState(rec),
			stage_name: str(rec.StageName),
			is_closed: typeof rec.IsClosed === "boolean" ? rec.IsClosed : null,
			is_won: typeof rec.IsWon === "boolean" ? rec.IsWon : null,
			opportunity_name: str(rec.Name),
			account_id: str(rec.AccountId),
			account_name: str(rec.Account?.Name),
			amount: num(rec.Amount),
			amount_currency: str(rec.CurrencyIsoCode),
			saas_revenue: num(rec.SaaS_Revenue__c),
			saas_revenue_usd: num(rec.SaaS_Revenue_USD__c),
			close_date: str(rec.CloseDate),
			market: str(rec.Market__c),
			commercial_region: str(rec.Commercial_Region__c),
			opportunity_owner: str(rec.Owner?.Name),
			primary_campaign_source: str(rec.CampaignId),
			customer_expansion_raw: str(rec.Existing_Customer_or_New_Business__c),
			sales_development_rep_user_id: str(rec.Sales_Development_Rep__c),
			created_by_user_id: str(rec.CreatedById),
			suggested_bdr_name: suggestedBdrName(rec),
			insurance_vertical_raw: str(rec[INDUSTRY_VERTICAL_CANDIDATES_FULL[0]]),
			industry_vertical_raw: str(rec[INDUSTRY_VERTICAL_CANDIDATES_FULL[1]]),
			pursuit_industry_vertical_raw: str(rec[INDUSTRY_VERTICAL_CANDIDATES_FULL[2]]),
			gtm_cube: str(rec.GTM_Cube__c),
			business_units: str(rec.Business_Units__c),
			sf_created_at: str(rec.CreatedDate),
			sf_last_modified_at: modstamp
		};
		return {
			...withoutHash,
			content_hash: snapshotFingerprint(withoutHash)
		};
	}
	var INDUSTRY_VERTICAL_CANDIDATES_FULL = ["Insurance_vertical__c", ...INDUSTRY_VERTICAL_CANDIDATES.filter((f) => f !== "Insurance_vertical__c")];
	function snapshotFingerprint(payload) {
		const orderedFields = Object.keys(payload).sort();
		return `sha256:${sha256Hex(JSON.stringify(orderedFields.map((field) => [field, payload[field] ?? null])))}`;
	}
	function eventContentFingerprint(event) {
		return `sha256:${sha256Hex(JSON.stringify([
			event.sf_opportunity_id,
			event.sf_history_id,
			event.source_field,
			event.old_value,
			event.new_value,
			event.event_kind,
			event.from_record_type_state,
			event.to_record_type_state,
			event.from_terminal_state,
			event.to_terminal_state,
			canonicalEventTimestamp(event.changed_at)
		]))}`;
	}
	function eventRowContentFingerprint(content) {
		return `sha256:${sha256Hex(JSON.stringify([
			content.sfOpportunityId,
			content.sourceField,
			content.oldValue,
			content.newValue,
			canonicalEventTimestamp(content.changedAt)
		]))}`;
	}
	var FUNNEL_STATES = new Set([
		"hpp",
		"opp",
		"pursuit"
	]);
	function classifyCandidateEligibility(rec, existing, config) {
		const link = existing.links[rec.Id];
		if (link?.linkState === "active") return "linked_active";
		if (link?.linkState === "retired") return "linked_retired";
		const state = normalizedRecordTypeState(rec);
		if (state === "unknown") return "excluded_unknown_record_type";
		if (!FUNNEL_STATES.has(state)) return "excluded_out_of_scope";
		const createdYear = Number((rec.CreatedDate ?? "").slice(0, 4));
		if (!Number.isInteger(createdYear) || !config.reportingYears.includes(createdYear)) return "excluded_outside_reporting_years";
		const businessType = normalizeSourceValue(typeof rec.Existing_Customer_or_New_Business__c === "string" ? rec.Existing_Customer_or_New_Business__c : null);
		if (businessType === null) return "excluded_missing_business_type";
		if (!config.includedBusinessTypeApiValues.includes(businessType)) return "excluded_non_new_logo";
		const review = existing.reviews[rec.Id];
		if (review) {
			if (review.reviewState === "pending") return "already_pending_review";
			return "blocked_by_review_state";
		}
		return "eligible_new_candidate";
	}
	function isStaged(outcome, hasExistingReview) {
		switch (outcome) {
			case "eligible_new_candidate":
			case "already_pending_review":
			case "blocked_by_review_state":
			case "linked_active":
			case "linked_retired": return true;
			case "excluded_out_of_scope":
			case "excluded_unknown_record_type":
			case "excluded_outside_reporting_years":
			case "excluded_missing_business_type":
			case "excluded_non_new_logo": return hasExistingReview;
		}
	}
	function planStagingIngestion(records, historyRecords, recordTypeRefs, existing, config) {
		assertUniqueSourceIds(records.map((r) => r.Id), "Opportunity");
		const prepared = prepareHistoryRows(historyRecords, recordTypeRefs);
		const operations = [];
		const eligibility = {
			eligible_new_candidate: 0,
			already_pending_review: 0,
			blocked_by_review_state: 0,
			excluded_out_of_scope: 0,
			excluded_unknown_record_type: 0,
			excluded_outside_reporting_years: 0,
			excluded_missing_business_type: 0,
			excluded_non_new_logo: 0,
			linked_active: 0,
			linked_retired: 0
		};
		const linked = {
			activeSynced: 0,
			nowUnavailableService: 0,
			restoredToFunnel: 0,
			retiredNoAction: 0
		};
		let excludedNotStaged = 0;
		let reviewsCreated = 0;
		let reviewIssueUpdates = 0;
		let snapshotsPlanned = 0;
		let snapshotNoops = 0;
		let staleSnapshotsSkipped = 0;
		let snapshotConflicts = 0;
		let ownerLabelRepairs = 0;
		const outcomes = /* @__PURE__ */ new Map();
		const stagedRecords = [];
		for (const rec of records) {
			const outcome = classifyCandidateEligibility(rec, existing, config);
			outcomes.set(rec.Id, outcome);
			eligibility[outcome] += 1;
			if (isStaged(outcome, existing.reviews[rec.Id] !== void 0)) stagedRecords.push(rec);
			else excludedNotStaged += 1;
		}
		const stagedIds = new Set(stagedRecords.map((r) => r.Id));
		const stagedRows = prepared.rows.filter((row) => stagedIds.has(row.opportunityId));
		const derived = adaptOpportunityHistory(stagedRows, DRY_RUN_STAGE_CONFIG, stagedRecords.map((r) => mapBaselineObservation(r, config.runStartedAt)));
		const derivedById = new Map(derived.opportunities.map((o) => [o.opportunityId, o]));
		for (const rec of stagedRecords) {
			const payload = buildSnapshotPayload(rec);
			const prior = existing.snapshots[rec.Id];
			if (prior) {
				const priorMs = parseSourceInstant(prior.sfLastModifiedAt);
				const incomingMs = parseSourceInstant(payload.sf_last_modified_at);
				if (priorMs !== null && incomingMs < priorMs) {
					operations.push({
						op: "noop_stale_snapshot",
						table: "sf_opportunities",
						sfOpportunityId: rec.Id
					});
					staleSnapshotsSkipped += 1;
					continue;
				}
				if (priorMs !== null && incomingMs === priorMs) {
					if (prior.contentHash === payload.content_hash) {
						operations.push({
							op: "noop_snapshot",
							table: "sf_opportunities",
							sfOpportunityId: rec.Id
						});
						snapshotNoops += 1;
						continue;
					}
					const legacyOwnerId = str(rec.OwnerId);
					const ownerName = str(rec.Owner?.Name);
					if (legacyOwnerId !== null && ownerName !== null && legacyOwnerId !== ownerName) {
						const { content_hash: incomingHash, ...incomingFields } = payload;
						const ownerOnlyLegacyHash = snapshotFingerprint({
							...incomingFields,
							opportunity_owner: legacyOwnerId
						});
						const { account_id: incomingAccountId, ...preAccountFields } = incomingFields;
						const ownerAndAccountLegacyHash = snapshotFingerprint({
							...preAccountFields,
							opportunity_owner: legacyOwnerId
						});
						const repairKind = prior.contentHash === ownerOnlyLegacyHash ? "owner_label_only" : prior.contentHash === ownerAndAccountLegacyHash ? "owner_and_account_shape" : null;
						if (repairKind !== null) {
							operations.push({
								op: "repair_owner_label",
								table: "sf_opportunities",
								sfOpportunityId: rec.Id,
								repair: {
									sf_opportunity_id: rec.Id,
									repair_kind: repairKind,
									legacy_owner_user_id: legacyOwnerId,
									owner_name: ownerName,
									account_id: incomingAccountId,
									sf_last_modified_at: payload.sf_last_modified_at,
									prior_content_hash: repairKind === "owner_label_only" ? ownerOnlyLegacyHash : ownerAndAccountLegacyHash,
									content_hash: incomingHash
								}
							});
							ownerLabelRepairs += 1;
							continue;
						}
					}
					operations.push({
						op: "block_snapshot_conflict",
						table: "sf_opportunities",
						sfOpportunityId: rec.Id
					});
					snapshotConflicts += 1;
					continue;
				}
				if (prior.contentHash === payload.content_hash) {
					operations.push({
						op: "noop_snapshot",
						table: "sf_opportunities",
						sfOpportunityId: rec.Id
					});
					snapshotNoops += 1;
					continue;
				}
			}
			operations.push({
				op: "upsert_snapshot",
				table: "sf_opportunities",
				sfOpportunityId: rec.Id,
				payload,
				changed: prior !== void 0
			});
			snapshotsPlanned += 1;
		}
		const conflictedByOpportunity = /* @__PURE__ */ new Map();
		let exactDuplicateEvents = 0;
		const recordTypeField = DRY_RUN_STAGE_CONFIG.recordTypeFieldName;
		const stageField = DRY_RUN_STAGE_CONFIG.stageFieldName ?? "StageName";
		for (const row of stagedRows) {
			if (row.field !== recordTypeField && row.field !== stageField) continue;
			const incoming = {
				sfOpportunityId: row.opportunityId,
				sourceField: row.field,
				oldValue: row.oldValue,
				newValue: row.newValue,
				changedAt: row.changedAt
			};
			const stored = existing.eventContentByHistoryId[row.historyId];
			const cls = classifyIncomingEvent(stored, incoming);
			if (cls === "exact_duplicate") {
				operations.push({
					op: "noop_duplicate_event",
					table: "sf_opportunity_events",
					sfHistoryId: row.historyId
				});
				exactDuplicateEvents += 1;
				continue;
			}
			if (cls === "conflict") {
				operations.push({
					op: "block_conflicting_event",
					table: "sf_opportunity_events",
					sfHistoryId: row.historyId,
					sfOpportunityId: row.opportunityId
				});
				const list = conflictedByOpportunity.get(row.opportunityId) ?? [];
				list.push({
					historyId: row.historyId,
					acceptedHash: eventRowContentFingerprint(stored),
					conflictingHash: eventRowContentFingerprint(incoming)
				});
				conflictedByOpportunity.set(row.opportunityId, list);
				continue;
			}
			const ledgerEvent = derived.ledger.find((e) => e.sourceHistoryId === row.historyId);
			const terminalEvent = derived.terminalLedger.find((e) => e.sourceHistoryId === row.historyId);
			if (terminalEvent) {
				const event = buildTerminalEventInsert(terminalEvent, row.field);
				operations.push({
					op: "insert_event",
					table: "sf_opportunity_events",
					event,
					contentHash: eventContentFingerprint(event)
				});
			} else if (ledgerEvent && !ledgerEvent.baselineObservation) {
				const event = buildRecordTypeEventInsert(ledgerEvent, row.field);
				operations.push({
					op: "insert_event",
					table: "sf_opportunity_events",
					event,
					contentHash: eventContentFingerprint(event)
				});
			}
		}
		for (const rec of stagedRecords) {
			const outcome = outcomes.get(rec.Id);
			if (outcome === "linked_active") {
				linked.activeSynced += 1;
				const nowState = normalizedRecordTypeState(rec);
				const priorDev = existing.snapshots[rec.Id]?.recordTypeDeveloperName;
				const priorState = priorDev === null || priorDev === void 0 ? null : DEFAULT_OPPORTUNITY_RECORD_TYPE_MAP[priorDev] ?? "unknown";
				if (nowState === "out_of_scope" && priorState !== "out_of_scope") linked.nowUnavailableService += 1;
				if (FUNNEL_STATES.has(nowState) && priorState === "out_of_scope") linked.restoredToFunnel += 1;
				continue;
			}
			if (outcome === "linked_retired") {
				linked.retiredNoAction += 1;
				continue;
			}
			if (outcome !== "eligible_new_candidate" && outcome !== "already_pending_review") continue;
			const derivedState = derivedById.get(rec.Id);
			if (!derivedState) continue;
			const seed = buildReviewSeed(derivedState, {
				primaryCampaignSource: normalizeSourceValue(rec.CampaignId ?? null),
				commercialRegion: normalizeSourceValue(rec.Commercial_Region__c ?? null)
			}, derived.review);
			if (conflictedByOpportunity.has(rec.Id) && !seed.issue_codes.includes("conflicting_history_id")) seed.issue_codes = [...seed.issue_codes, "conflicting_history_id"].sort();
			const existingReview = existing.reviews[rec.Id];
			const buildConflictAudits = (projection) => (conflictedByOpportunity.get(rec.Id) ?? []).map((c) => recordIngestionConflict(projection, {
				sfHistoryId: c.historyId,
				acceptedContentHash: c.acceptedHash,
				conflictingContentHash: c.conflictingHash
			}, {
				actorType: "ingestion",
				occurredAt: config.runStartedAt
			}).auditEvent);
			if (outcome === "eligible_new_candidate" && !existingReview) {
				const mutation = createReviewMutation(seed, {
					actorType: "ingestion",
					occurredAt: config.runStartedAt
				});
				operations.push({
					op: "create_review",
					table: "sf_opportunity_reviews",
					seed,
					auditEvents: [mutation.auditEvent, ...buildConflictAudits(mutation.projection)]
				});
				reviewsCreated += 1;
				continue;
			}
			if (outcome === "already_pending_review" && existingReview) {
				let nextIssueCodes = seed.issue_codes;
				if (existingReview.channelId !== null) nextIssueCodes = nextIssueCodes.filter((c) => c !== "missing_channel");
				const currentCodes = [...existingReview.issueCodes].sort().join("|");
				const nextCodes = [...nextIssueCodes].sort().join("|");
				const projection = {
					reviewState: existingReview.reviewState,
					issueCodes: nextIssueCodes,
					channelId: existingReview.channelId,
					leadId: existingReview.leadId ?? null
				};
				if (currentCodes !== nextCodes) {
					operations.push({
						op: "update_review_issues",
						table: "sf_opportunity_reviews",
						sfOpportunityId: rec.Id,
						projection,
						auditEvents: [{
							event_type: "issues_updated",
							previous_state: null,
							new_state: null,
							issue_codes_snapshot: [...nextIssueCodes].sort(),
							actor_type: "ingestion",
							actor_id: null,
							note: null,
							sf_history_id: null,
							accepted_content_hash: null,
							conflicting_content_hash: null,
							dedupe_key: `issues:${rec.Id}:${nextCodes}`,
							occurred_at: config.runStartedAt
						}, ...buildConflictAudits(projection)]
					});
					reviewIssueUpdates += 1;
				} else if (conflictedByOpportunity.has(rec.Id)) operations.push({
					op: "append_review_audit",
					table: "sf_opportunity_review_events",
					sfOpportunityId: rec.Id,
					auditEvents: buildConflictAudits(projection)
				});
			}
		}
		let maxModstamp = null;
		for (const rec of records) {
			const stamp = rec.SystemModstamp ?? rec.LastModifiedDate ?? null;
			if (stamp && (maxModstamp === null || stamp > maxModstamp)) maxModstamp = stamp;
		}
		let maxHistory = null;
		for (const h of historyRecords) if (h.CreatedDate && (maxHistory === null || h.CreatedDate > maxHistory)) maxHistory = h.CreatedDate;
		const diagnostics = {
			runStartedAt: config.runStartedAt,
			proposedWatermarkSystemModstamp: maxModstamp,
			proposedWatermarkHistoryCreatedAt: maxHistory,
			rowsDiscovered: records.length,
			excludedNotStaged,
			eventsPlanned: operations.filter((o) => o.op === "insert_event").length,
			exactDuplicateEvents,
			conflictingEvents: [...conflictedByOpportunity.values()].reduce((a, b) => a + b.length, 0),
			snapshotsPlanned,
			snapshotNoops,
			staleSnapshotsSkipped,
			snapshotConflicts,
			ownerLabelRepairs,
			reviewsCreated,
			reviewIssueUpdates,
			eligibility,
			linked
		};
		operations.push({
			op: "record_sync_run",
			table: "sf_opportunity_sync_runs",
			diagnostics
		});
		return {
			dryRunCompatible: true,
			operations,
			diagnostics
		};
	}
	function serializeApplyPayload(plan) {
		const payload = {
			p_owner_repairs: [],
			p_snapshots: [],
			p_events: [],
			p_reviews: [],
			p_run: {
				started_at: plan.diagnostics.runStartedAt,
				watermark_system_modstamp: plan.diagnostics.proposedWatermarkSystemModstamp,
				watermark_history_created_at: plan.diagnostics.proposedWatermarkHistoryCreatedAt,
				rows_discovered: plan.diagnostics.rowsDiscovered,
				conflicts: plan.diagnostics.conflictingEvents
			}
		};
		for (const operation of plan.operations) switch (operation.op) {
			case "repair_owner_label":
				payload.p_owner_repairs.push(operation.repair);
				break;
			case "upsert_snapshot":
				payload.p_snapshots.push(operation.payload);
				break;
			case "insert_event":
				payload.p_events.push({
					...operation.event,
					content_hash: operation.contentHash
				});
				break;
			case "create_review":
				payload.p_reviews.push({
					kind: "create",
					sf_opportunity_id: operation.seed.sf_opportunity_id,
					issue_codes: operation.seed.issue_codes,
					audits: operation.auditEvents
				});
				break;
			case "update_review_issues":
				payload.p_reviews.push({
					kind: "update_issues",
					sf_opportunity_id: operation.sfOpportunityId,
					issue_codes: operation.projection.issueCodes,
					audits: operation.auditEvents
				});
				break;
			case "append_review_audit":
				payload.p_reviews.push({
					kind: "audit_only",
					sf_opportunity_id: operation.sfOpportunityId,
					issue_codes: [],
					audits: operation.auditEvents
				});
				break;
			case "noop_snapshot":
			case "noop_stale_snapshot":
			case "noop_duplicate_event":
			case "block_snapshot_conflict":
			case "block_conflicting_event":
			case "record_sync_run": break;
			default: throw new Error(`serialize: unknown operation kind ${JSON.stringify(operation)}`);
		}
		payload.p_snapshots.sort((a, b) => a.sf_opportunity_id.localeCompare(b.sf_opportunity_id));
		payload.p_owner_repairs.sort((a, b) => a.sf_opportunity_id.localeCompare(b.sf_opportunity_id));
		payload.p_events.sort((a, b) => a.sf_history_id.localeCompare(b.sf_history_id));
		payload.p_reviews.sort((a, b) => a.sf_opportunity_id.localeCompare(b.sf_opportunity_id));
		return payload;
	}
	//#endregion
	//#region src/lib/opportunityDailyRuntimeEntry.ts
	var EMPTY_STATE = {
		snapshots: {},
		eventContentByHistoryId: {},
		reviews: {},
		links: {}
	};
	function planOpportunityDailyRun(input) {
		if (!Array.isArray(input.opportunities)) throw new Error("runtime: opportunities must be an array");
		if (!Array.isArray(input.historyRecords)) throw new Error("runtime: historyRecords must be an array");
		if (!Array.isArray(input.recordTypeRefs)) throw new Error("runtime: recordTypeRefs must be an array");
		if (!input.existingState || typeof input.existingState !== "object") throw new Error("runtime: existingState is required");
		if (!Number.isFinite(Date.parse(input.runStartedAt))) throw new Error("runtime: runStartedAt must be a real timestamp");
		if (!Array.isArray(input.reportingYears) || input.reportingYears.length === 0 || input.reportingYears.some((year) => !Number.isInteger(year))) throw new Error("runtime: reportingYears must contain integers");
		if (!Array.isArray(input.includedBusinessTypeApiValues) || input.includedBusinessTypeApiValues.length !== 1 || input.includedBusinessTypeApiValues[0] !== "New Project") throw new Error("runtime: the confirmed New Logo API value must be exactly New Project");
		const config = {
			reportingYears: [...input.reportingYears],
			includedBusinessTypeApiValues: [...input.includedBusinessTypeApiValues],
			runStartedAt: input.runStartedAt
		};
		const state = {
			...EMPTY_STATE,
			...input.existingState
		};
		const plan = planStagingIngestion(input.opportunities, input.historyRecords, input.recordTypeRefs, state, config);
		const payload = serializeApplyPayload(plan);
		const currentPipeline = {
			hpp: 0,
			opp: 0,
			pursuit: 0
		};
		const suggestedBdrs = {
			dave_cummins: 0,
			garrett_mcnally: 0,
			none: 0
		};
		let open = 0;
		let closed = 0;
		for (const record of input.opportunities) {
			if (classifyCandidateEligibility(record, state, config).startsWith("excluded_")) continue;
			const suggestedBdr = suggestedBdrName(record);
			if (suggestedBdr === "Dave Cummins") suggestedBdrs.dave_cummins += 1;
			else if (suggestedBdr === "Garrett McNally") suggestedBdrs.garrett_mcnally += 1;
			else suggestedBdrs.none += 1;
			if (record.IsClosed === true) {
				closed += 1;
				continue;
			}
			const stage = normalizedRecordTypeState(record);
			if (stage === "hpp" || stage === "opp" || stage === "pursuit") {
				currentPipeline[stage] += 1;
				open += 1;
			}
		}
		return {
			summary: {
				status: "PLAN_COMPLETE",
				dry_run: true,
				writes_attempted: 0,
				reporting_years: [...input.reportingYears],
				included_business_type_api_values: [...input.includedBusinessTypeApiValues],
				primary_revenue_field: "SaaS_Revenue_USD__c",
				stored_hidden_revenue_fields: ["Amount", "SaaS_Revenue__c"],
				source_opportunities: input.opportunities.length,
				source_history_rows: input.historyRecords.length,
				record_type_references: input.recordTypeRefs.length,
				open_current_pipeline: open,
				closed_staged_for_review: closed,
				current_pipeline_by_record_type: currentPipeline,
				suggested_bdrs: suggestedBdrs,
				source_attribution_requires_human_review: true,
				owner_label_repairs_planned: payload.p_owner_repairs.length,
				snapshots_planned: payload.p_snapshots.length,
				reviews_planned: payload.p_reviews.length,
				events_planned: payload.p_events.length,
				reconciliation_complete: open + closed === input.opportunities.length - plan.diagnostics.excludedNotStaged,
				planner_diagnostics: plan.diagnostics
			},
			payload
		};
	}
	//#endregion
	exports.planOpportunityDailyRun = planOpportunityDailyRun;
	return exports;
})({});
