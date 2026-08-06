FROM afk-sandbox-base:node22

USER root

# Claude extension image: only the agent CLI; common shell and language tools
# are inherited from afk-sandbox-base.
RUN npm install --global @anthropic-ai/claude-code@latest \
    && chown -R node:node /usr/local/lib/node_modules /usr/local/bin

USER node
WORKDIR /workspace

CMD ["sleep", "infinity"]
