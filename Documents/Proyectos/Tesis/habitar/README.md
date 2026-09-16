# Habitar

Plataforma SaaS de comprensión lectora asistida por IA. Monorepo con
frontend (React + Vite + PWA + Tailwind) y backend (Node/Express en
arquitectura por capas), preparado para PostgreSQL multitenant
(schema-per-tenant).

## Arquitectura del backend (por capas)

```
Route  ->  Controller  ->  Service (BLL)  ->  Repository (DAL/DAO)  ->  PostgreSQL
```

- **Routes** (`*.routes.js`): sólo mapean método+path a un controller.
- **Controllers** (`*.controller.js`): traducen HTTP <-> llamadas al
  Service. Sin lógica de negocio.
- **Services** (`*.service.js`, la BLL): orquestan reglas de negocio,
  no conocen Express ni SQL.
- **Repositories** (`*.repository.js`, el DAO/DAL): única capa que
  habla SQL contra `pg`. Cada método recibe el `schema` del tenant
  cuando la tabla vive en un schema institucional.

Módulos ya armados en `backend/src/modules`:
- `auth` — login OIDC (Google Workspace / Microsoft 365) + sesión JWT.
- `students` — acceso sin cuenta por código corto / QR.
- `tenants` — resolución de tenant (dominio -> schema de PostgreSQL).

## Requisitos

- Node.js 20+
- PostgreSQL 16 (o `docker compose up db`)

## Arranque en desarrollo

```bash
# Backend
cd habitar/backend
cp .env.example .env   # completá GOOGLE_/MICROSOFT_ client id & secret
npm install
npm run migrate        # crea schema public + schemas de tenants existentes
npm run dev             # http://localhost:4000

# Frontend (en otra terminal)
cd habitar/frontend
npm install
npm run dev              # http://localhost:5173
```

Para dar de alta la primera institución (tenant), insertá una fila en
`public.tenants` (`schema_name` sólo letras/números/`_`, ej. `demo`)
y volvé a correr `npm run migrate` para crear su schema.

## Docker

```bash
docker compose up --build
```

## Variables de entorno clave (`backend/.env`)

Ver `backend/.env.example`. Los client id/secret de Google y Microsoft
son necesarios para que el login OAuth funcione; sin ellos, `npm run dev`
levanta igual pero `/api/auth/:provider` fallará al no poder hacer
`Issuer.discover`/token exchange.

## Roadmap (fases del plan original)

- [x] Fase 1 — Auth institucional (Google/Microsoft) + layout base + PWA scaffold.
- [ ] Fase 2 — Generación de preguntas con DeepSeek (stepper Nueva actividad).
- [ ] Fase 3 — Experiencia del alumno mobile-first (resolución de actividad, offline-first).
- [ ] Fase 4 — Dashboards institucionales, gráficos y cumplimiento (Ley de Protección de Datos, ARCO).
