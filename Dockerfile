FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
RUN mkdir -p ./public
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# `GET /api/docs` serves this file at runtime; the standalone output does not carry it.
COPY --from=builder --chown=nextjs:nodejs /app/docs ./docs
# Copy node_modules for non-bundled deps (pg, imapflow, nodemailer, bcryptjs)
COPY --from=deps --chown=nextjs:nodejs /app/node_modules ./node_modules
# OCR des PDF image (lib/ged/ocr.ts) : tout tourne sur l'instance, aucun téléchargement à l'exécution.
# `tesseract-ocr-data-osd` est requis par `--psm 1` (orientation automatique) — sans lui tesseract ne charge aucune langue.
RUN apk add --no-cache poppler-utils tesseract-ocr tesseract-ocr-data-fra tesseract-ocr-data-eng tesseract-ocr-data-osd
USER nextjs
EXPOSE 3000
CMD ["node", "--max-old-space-size=768", "server.js"]
