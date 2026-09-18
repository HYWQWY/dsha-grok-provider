window.__ModuleLoader__.load({
	id: "dsha-grok-provider",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require("react");
		let jsxRuntime = require("react/jsx-runtime");
		const { useState, useEffect, useCallback, useRef } = react;
		const { jsx, jsxs, Fragment } = jsxRuntime;

		const CHANNEL = "/grok-sub-auth";
		const isZh = typeof navigator !== "undefined" && /^(zh|zh-CN|zh-TW|zh-HK)/i.test(navigator.language || "zh");

		const I18N = {
			title: isZh ? "订阅中心" : "Subscriptions Hub",
			subtitle: isZh
				? "用已有订阅登录，不需要 API Key。登录后模型选择器会出现对应模型。代理掐流时会自动直连重试。"
				: "Sign in with existing subscriptions without API keys. Available models appear in model picker after sign-in. Auto-fallbacks to direct connection when proxy stalls.",
			loading: isZh ? "查询登录状态…" : "Checking login status...",
			login: isZh ? "登录" : "Sign In",
			logout: isZh ? "退出登录" : "Sign Out",
			cancel: isZh ? "取消" : "Cancel",
			processing: isZh ? "处理中" : "Processing",
			loggingIn: isZh ? "登录中…" : "Signing in...",
			loggedIn: isZh ? "已登录" : "Signed In",
			loggedOut: isZh ? "未登录" : "Signed Out",
			submit: isZh ? "提交" : "Submit",
			manualPlaceholder: isZh ? "浏览器回调失败时，把授权码/链接粘贴到这里" : "Paste callback URL or code here if browser redirect fails",
			userCodePrefix: isZh ? "设备码：" : "User Code: ",
			userCodeSuffix: isZh ? " 在浏览器确认后会自动完成登录。" : " Complete verification in browser to finish sign-in.",
			copyCode: isZh ? "复制设备码" : "Copy Code",
			copied: isZh ? "已复制" : "Copied",
			copyError: isZh ? "复制报错" : "Copy Error",
			openAuthUrl: isZh ? "打不开窗口的话点这里打开授权页" : "Click here if authorization window did not open",
			unlockedModels: isZh ? "可用模型" : "Available Models"
		};

		const PROVIDERS = [
  {
				id: "grok",
				name: "Grok",
				hint: isZh ? "xAI Grok 订阅 (X Premium / Premium+)" : "xAI Grok Subscription (X Premium / Premium+)",
				models: ["grok-2", "grok-2-mini", "grok-3"]
			}
];

		async function rpcCall(rpc, endpoint, payload) {
			const result = await rpc.call(CHANNEL, endpoint, payload);
			if (!result || result.ok !== true) {
				const msg = result && result.error ? result.error.message : (isZh ? "RPC 失败" : "RPC failed");
				throw new Error(msg);
			}
			return result.value;
		}

		function SubscriptionsSection(props) {
			const [statuses, setStatuses] = useState({});
			const [errors, setErrors] = useState({});
			const [loading, setLoading] = useState(true);
			const [manual, setManual] = useState({});
			const [copied, setCopied] = useState({});
			const mounted = useRef(true);
			const pollers = useRef({});

			const refresh = useCallback(async () => {
				const rpc = props.rpc;
				if (!rpc) return;
				try {
					const value = await rpcCall(rpc, "status", {});
					if (!mounted.current) return;
					const providers = value.providers || {};
					setStatuses(providers);
					setLoading(false);
					setErrors((prev) => {
						const next = { ...prev };
						delete next._global;
						for (const { id } of PROVIDERS) {
							const detail = providers[id] && providers[id].detail;
							if (typeof detail === "string" && detail) next[id] = detail;
							else delete next[id];
						}
						return next;
					});
				} catch (error) {
					if (!mounted.current) return;
					setLoading(false);
					setErrors((e) => ({ ...e, _global: error instanceof Error ? error.message : String(error) }));
				}
			}, [props.rpc]);

			useEffect(() => {
				mounted.current = true;
				refresh();
				return () => {
					mounted.current = false;
					for (const t of Object.values(pollers.current)) clearInterval(t);
					pollers.current = {};
				};
			}, [refresh]);

			useEffect(() => {
				for (const { id } of PROVIDERS) {
					const st = statuses[id];
					if (st?.busy && !pollers.current[id]) {
						pollers.current[id] = setInterval(() => { void refresh(); }, 2000);
					}
					if (st && !st.busy && pollers.current[id]) {
						clearInterval(pollers.current[id]);
						delete pollers.current[id];
					}
				}
			}, [statuses, refresh]);

			function startPoll(provider) {
				if (!pollers.current[provider]) pollers.current[provider] = setInterval(() => { void refresh(); }, 1500);
				setTimeout(() => {
					if (pollers.current[provider]) { clearInterval(pollers.current[provider]); delete pollers.current[provider]; }
				}, 180000);
			}

			async function login(provider) {
				try {
					setErrors((e) => { const n = { ...e }; delete n[provider]; return n; });
					const value = await rpcCall(props.rpc, "login", { provider });
					if (typeof value?.authorizeUrl === "string" && value.authorizeUrl) window.open(value.authorizeUrl, "_blank", "noopener");
					await refresh();
					startPoll(provider);
				} catch (error) {
					setErrors((e) => ({ ...e, [provider]: error instanceof Error ? error.message : String(error) }));
				}
			}
			async function logout(provider) {
				try {
					await rpcCall(props.rpc, "logout", { provider });
					await refresh();
				} catch (error) {
					setErrors((e) => ({ ...e, [provider]: error instanceof Error ? error.message : String(error) }));
				}
			}
			async function cancel(provider) {
				try {
					await rpcCall(props.rpc, "cancel", { provider });
					await refresh();
				} catch (error) {
					setErrors((e) => ({ ...e, [provider]: error instanceof Error ? error.message : String(error) }));
				}
			}
			async function submitManual(provider) {
				const input = (manual[provider] || "").trim();
				if (!input) return;
				try {
					await rpcCall(props.rpc, "manual", { provider, input });
					setManual((m) => ({ ...m, [provider]: "" }));
					await refresh();
				} catch (error) {
					setErrors((e) => ({ ...e, [provider]: error instanceof Error ? error.message : String(error) }));
				}
			}

			function copyText(key, text) {
				if (typeof navigator !== "undefined" && navigator.clipboard) {
					navigator.clipboard.writeText(text).catch(() => {});
				}
				setCopied((c) => ({ ...c, [key]: true }));
				setTimeout(() => setCopied((c) => ({ ...c, [key]: false })), 2000);
			}

			const container = { maxWidth: 740, display: "flex", flexDirection: "column", gap: 14, padding: 8 };
			const cardBase = { display: "flex", flexDirection: "column", gap: 10, padding: "12px 14px", borderRadius: 10, border: "1px solid var(--dsw-alias-border-l1)", background: "var(--dsw-alias-bg-container)" };
			const btnBase = { height: 30, padding: "0 14px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "var(--dsw-alias-interactive-bg)", cursor: "pointer", fontSize: 12 };
			const metaBase = { color: "var(--dsw-alias-label-secondary)", fontSize: 12, lineHeight: "18px" };
			const inputBase = { height: 30, padding: "0 10px", borderRadius: 8, border: "1px solid var(--dsw-alias-border-l2)", background: "transparent", color: "inherit", fontSize: 12, flex: 1, minWidth: 0 };
			const tagBase = { display: "inline-block", fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "var(--dsw-alias-fill-quaternary, rgba(127,127,127,0.12))", color: "var(--dsw-alias-label-secondary)" };

			return jsxs("div", { style: container, children: [
				jsx("div", { style: { fontSize: 16, fontWeight: 650 }, children: I18N.title }),
				jsx("div", { style: metaBase, children: I18N.subtitle }),
				loading ? jsx("div", { style: metaBase, children: I18N.loading }) : null,
				errors._global ? jsx("div", { style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12 }, children: errors._global }) : null,
				jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 10 }, children: PROVIDERS.map((p) => {
					const st = statuses[p.id] || {};
					const isLogged = st.loggedIn === true;
					const isBusy = st.busy === true;
					const err = errors[p.id];
					const userCode = typeof st.userCode === "string" ? st.userCode : "";
					const authorizeUrl = typeof st.authorizeUrl === "string" ? st.authorizeUrl : "";
					const account = typeof st.account === "string" ? st.account : "";
					const statusText = isBusy ? I18N.loggingIn : (isLogged ? (account || I18N.loggedIn) : I18N.loggedOut);
					const statusColor = isLogged ? "var(--dsw-alias-state-success, #52c41a)" : "var(--dsw-alias-label-secondary)";

					return jsxs("div", { key: p.id, style: cardBase, children: [
						jsxs("div", { style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }, children: [
							jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }, children: [
								jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8 }, children: [
									jsx("span", { style: { fontWeight: 600, fontSize: 14 }, children: p.name }),
									jsx("span", { style: { fontSize: 12, fontWeight: 500, color: statusColor }, children: `• ${statusText}` })
								] }),
								jsx("span", { style: { ...metaBase, opacity: 0.85 }, children: p.hint })
							] }),
							jsxs("div", { style: { display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }, children: [
								isBusy ? jsx("button", { type: "button", style: btnBase, onClick: () => { void cancel(p.id); }, children: I18N.cancel }) : null,
								jsx("button", {
									type: "button",
									style: {
										...btnBase,
										...(isLogged ? { borderColor: "var(--dsw-alias-border-l1)" } : { background: "var(--dsw-alias-brand-primary, #1677ff)", color: "#fff", border: "none" })
									},
									disabled: isBusy && !isLogged,
									onClick: () => { if (isLogged) void logout(p.id); else void login(p.id); },
									children: isBusy ? I18N.processing : (isLogged ? I18N.logout : I18N.login)
								})
							] })
						] }),
						isLogged && p.models && p.models.length > 0 ? jsxs("div", {
							style: { display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, paddingTop: 4, borderTop: "1px dashed var(--dsw-alias-border-l2, rgba(127,127,127,0.2))" },
							children: [
								jsx("span", { style: { ...metaBase, fontSize: 11, fontWeight: 500 }, children: `${I18N.unlockedModels}:` }),
								...p.models.map((m) => jsx("span", { key: m, style: tagBase, children: m }))
							]
						}) : null,
						err ? jsxs("div", {
							style: { color: "var(--dsw-alias-state-error-primary)", fontSize: 12, lineHeight: "18px", whiteSpace: "pre-wrap", display: "flex", justifyContent: "space-between", alignItems: "flex-start", background: "rgba(255, 0, 0, 0.05)", padding: "6px 8px", borderRadius: 6 },
							children: [
								jsx("span", { style: { flex: 1, wordBreak: "break-all" }, children: err }),
								jsx("button", {
									type: "button",
									style: { ...btnBase, height: 22, padding: "0 8px", fontSize: 11, flexShrink: 0, marginLeft: 8 },
									onClick: () => copyText(`err_${p.id}`, err),
									children: copied[`err_${p.id}`] ? I18N.copied : I18N.copyError
								})
							]
						}) : null,
						userCode ? jsxs("div", {
							style: { ...metaBase, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
							children: [
								jsx("span", { children: I18N.userCodePrefix }),
								jsx("code", { style: { fontWeight: 700, fontSize: 13, background: "rgba(127,127,127,0.15)", padding: "2px 6px", borderRadius: 4 }, children: userCode }),
								jsx("button", {
									type: "button",
									style: { ...btnBase, height: 24, padding: "0 8px", fontSize: 11 },
									onClick: () => copyText(`code_${p.id}`, userCode),
									children: copied[`code_${p.id}`] ? I18N.copied : I18N.copyCode
								}),
								jsx("span", { children: I18N.userCodeSuffix })
							]
						}) : null,
						isBusy && authorizeUrl ? jsx("a", { href: authorizeUrl, target: "_blank", rel: "noreferrer", style: { fontSize: 12, color: "var(--dsw-alias-brand-primary, #1677ff)" }, children: I18N.openAuthUrl }) : null,
						isBusy ? jsxs("div", { style: { display: "flex", gap: 8 }, children: [
							jsx("input", { style: inputBase, placeholder: I18N.manualPlaceholder, value: manual[p.id] || "", onChange: (event) => setManual((m) => ({ ...m, [p.id]: event.target.value })) }),
							jsx("button", { type: "button", style: btnBase, onClick: () => { void submitManual(p.id); }, children: I18N.submit })
						] }) : null
					] });
				}) })
			] });
		}

		const inject = ["slots", "connection"];
		function apply(ctx) {
			const connection = ctx.get("connection");
			if (!connection) return;
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "subs-hub",
				order: 88,
				label: () => I18N.title,
				inject: () => ({ rpc: connection.rpc })
			}, SubscriptionsSection));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
