"""OpenViking's declared config surface — rendered by the generic desktop/universal panel.

Stored in config.yaml under ``memory.openviking`` (the block the plugin's
runtime reads); the API key goes to the env store. Defaults mirror the
``_DEFAULT_*`` constants in ``__init__.py`` — a test pins them together.
"""

from plugins.memory.config_schema import (
    KIND_BOOL,
    KIND_NUMBER,
    KIND_SECRET,
    KIND_TEXT,
    STORAGE_CONFIG_YAML,
    ProviderConfigSchema,
    ProviderField,
)

_RECALL = "Recall"
_IDENTITY = "Identity"
_LOCAL = "Local server"

CONFIG_SCHEMA = ProviderConfigSchema(
    name="openviking",
    label="OpenViking",
    storage=STORAGE_CONFIG_YAML,
    docs_url="https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers#openviking",
    fields=(
        ProviderField(
            key="endpoint",
            label="Endpoint",
            kind=KIND_TEXT,
            default="http://127.0.0.1:1933",
            placeholder="http://127.0.0.1:1933",
            description="OpenViking server URL.",
            env_fallbacks=("OPENVIKING_ENDPOINT",),
            inline=True,
        ),
        ProviderField(
            key="api_key",
            label="API key",
            kind=KIND_SECRET,
            env_key="OPENVIKING_API_KEY",
            description="Required for any server that is not an unauthenticated local dev instance.",
            placeholder="Enter OpenViking API key",
            inline=True,
        ),
        ProviderField(
            key="agent",
            label="Agent",
            kind=KIND_TEXT,
            default="hermes",
            description="Hermes' peer ID in OpenViking, used for peer-scoped memories.",
            env_fallbacks=("OPENVIKING_AGENT",),
            inline=True,
        ),
        ProviderField(
            key="account",
            label="Account",
            kind=KIND_TEXT,
            description="Local/trusted-mode account override. Leave blank with a user API key.",
            env_fallbacks=("OPENVIKING_ACCOUNT",),
            group=_IDENTITY,
        ),
        ProviderField(
            key="user",
            label="User",
            kind=KIND_TEXT,
            description="Local/trusted-mode user override. Leave blank with a user API key.",
            env_fallbacks=("OPENVIKING_USER",),
            group=_IDENTITY,
        ),
        ProviderField(
            key="use_ovcli_config",
            label="Read ovcli.conf",
            kind=KIND_BOOL,
            default="false",
            description="Take endpoint and credentials from an OpenViking CLI profile instead of the fields above.",
            group=_IDENTITY,
        ),
        ProviderField(
            key="ovcli_config_path",
            label="ovcli.conf path",
            kind=KIND_TEXT,
            placeholder="~/.openviking/ovcli.conf",
            env_fallbacks=("OPENVIKING_CLI_CONFIG_FILE",),
            group=_IDENTITY,
        ),
        ProviderField(
            key="server_command",
            label="Server command",
            kind=KIND_TEXT,
            default="openviking-server",
            placeholder="openviking-server",
            description="Command Hermes runs when a local endpoint is down. Point it at a source checkout to run a branch.",
            info=(
                "Example: uv run --project ~/src/OpenViking openviking-server --config ~/.openviking/ov.conf. "
                "Hermes appends --host and --port."
            ),
            env_fallbacks=("OPENVIKING_SERVER_COMMAND",),
            group=_LOCAL,
        ),
        ProviderField(
            key="recall_limit",
            label="Recall limit",
            kind=KIND_NUMBER,
            default="6",
            description="Maximum memories injected by automatic recall (1–100).",
            env_fallbacks=("OPENVIKING_RECALL_LIMIT",),
            group=_RECALL,
        ),
        ProviderField(
            key="recall_score_threshold",
            label="Score threshold",
            kind=KIND_NUMBER,
            default="0.15",
            description="Minimum relevance score for automatic recall (0–1).",
            env_fallbacks=("OPENVIKING_RECALL_SCORE_THRESHOLD",),
            group=_RECALL,
        ),
        ProviderField(
            key="recall_max_injected_chars",
            label="Max injected chars",
            kind=KIND_NUMBER,
            default="4000",
            description="Maximum total characters injected by recall.",
            env_fallbacks=("OPENVIKING_RECALL_MAX_INJECTED_CHARS",),
            group=_RECALL,
        ),
        ProviderField(
            key="profile_token_budget",
            label="Profile token budget",
            kind=KIND_NUMBER,
            default="6000",
            description="Maximum session-start memory tokens injected.",
            env_fallbacks=("OPENVIKING_PROFILE_TOKEN_BUDGET",),
            group=_RECALL,
        ),
        ProviderField(
            key="recall_timeout_seconds",
            label="Recall timeout (s)",
            kind=KIND_NUMBER,
            default="4.0",
            description="Total timeout for one recall pass.",
            env_fallbacks=("OPENVIKING_RECALL_TIMEOUT_SECONDS",),
            group=_RECALL,
        ),
        ProviderField(
            key="recall_request_timeout_seconds",
            label="Request timeout (s)",
            kind=KIND_NUMBER,
            default="3.0",
            description="Per-request timeout inside a recall pass.",
            env_fallbacks=("OPENVIKING_RECALL_REQUEST_TIMEOUT_SECONDS",),
            group=_RECALL,
        ),
        ProviderField(
            key="recall_full_read_limit",
            label="Full reads per recall",
            kind=KIND_NUMBER,
            default="2",
            description="Maximum full (L2) content reads per recall.",
            env_fallbacks=("OPENVIKING_RECALL_FULL_READ_LIMIT",),
            group=_RECALL,
        ),
        ProviderField(
            key="recall_prefer_abstract",
            label="Prefer abstracts",
            kind=KIND_BOOL,
            default="false",
            description="Inject abstracts instead of full L2 reads.",
            env_fallbacks=("OPENVIKING_RECALL_PREFER_ABSTRACT",),
            group=_RECALL,
        ),
        ProviderField(
            key="recall_resources",
            label="Include resources",
            kind=KIND_BOOL,
            default="false",
            description="Let recall return ingested resources, not only memories.",
            env_fallbacks=("OPENVIKING_RECALL_RESOURCES",),
            group=_RECALL,
        ),
    ),
)
