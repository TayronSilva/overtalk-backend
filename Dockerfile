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

# Pré-carrega o modelo ONNX durante o build (evita download na inicialização)
RUN node preload-models.js

# Porta usada pelo Express
EXPOSE 3000

CMD ["node", "server.js"]
