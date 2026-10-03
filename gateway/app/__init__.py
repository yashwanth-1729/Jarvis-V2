"""HOLO gateway: the public edition's only path to paid AI providers.

The phone never holds a provider key in the public edition. Its on-device
backend points ``API_BASE`` at this service instead of OpenRouter and sends the
user's Supabase access token as the bearer token. For every call the gateway
verifies the user, checks the plan allows the feature, reserves Aura, forwards
to OpenRouter with the server's own key, then settles the real cost and writes
a usage row. See ``gateway/README.md`` for the API contract.
"""
