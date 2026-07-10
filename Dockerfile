FROM node:22-slim

WORKDIR /app

# Instalar dependências do sistema necessárias para better-sqlite3
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

# Copiar dependências primeiro (aproveitar cache)
COPY package*.json ./
RUN npm install --omit=dev

# Copiar código fonte
COPY . .

# Hugging Face Spaces requires port 7860
ENV PORT=7860
EXPOSE 7860

CMD ["node", "server.js"]
