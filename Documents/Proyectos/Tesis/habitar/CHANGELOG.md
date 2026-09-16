# Bitácora Oficial de Cambios y Desarrollo — Plataforma Habitar

Este documento recopila de manera cronológica y detallada todas las implementaciones, mejoras de arquitectura, migraciones de base de datos, módulos de interfaz y adaptaciones normativas aplicadas en la plataforma **Habitar** (Backend & Frontend).

---

## Índice de Contenidos
1. [Logo Oficial, Identidad Visual y SEO Integral](#1-logo-oficial-identidad-visual-y-seo-integral)
2. [Modo Impersonación de Super Administrador y Bypass de Guards](#2-modo-impersonación-de-super-administrador-y-bypass-de-guards)
3. [Sistema Granular de Roles RBAC y Permisos por Módulo](#3-sistema-granular-de-roles-rbac-y-permisos-por-módulo)
4. [Gestión de Planes de Suscripción y Personalización por Negocio](#4-gestión-de-planes-de-suscripción-y-personalización-por-negocio)
5. [Sistema de Aulas Físicas con QR Fijo, Escáner en App y Carga de Lecturas](#5-sistema-de-aulas-físicas-con-qr-fijo-escáner-en-app-y-carga-de-lecturas)
6. [Landing Page Institucional y Vinculación Dinámica de Precios](#6-landing-page-institucional-y-vinculación-dinámica-de-precios)
7. [Privacidad, Gobernanza de Datos y Normativa Educativa de la Provincia de Buenos Aires (DGCyE)](#7-privacidad-gobernanza-de-datos-y-normativa-educativa-de-la-provincia-de-buenos-aires-dgcye)
8. [Acceso 100% Público a la Privacidad y Consentimiento Escolar](#8-acceso-100-público-a-la-privacidad-y-consentimiento-escolar)
9. [Asignación y Delegación de Aulas a Docentes por Directores y Coordinadores](#9-asignación-y-delegación-de-aulas-a-docentes-por-directores-y-coordinadores)
10. [Conexión con Resend para Envíos de Notificaciones e Invitaciones Institucionales](#10-conexión-con-resend-para-envíos-de-notificaciones-e-invitaciones-institucionales)
11. [Soporte Multimodelo de IA (DeepSeek y OpenAI) y Gestión de Claves por Institución (BYOK)](#11-soporte-multimodelo-de-ia-deepseek-y-openai-y-gestión-de-claves-por-institución-byok)
12. [Página Pública de Marca, Identidad y Kit de Medios Oficial (`/brand`)](#12-página-pública-de-marca-identidad-y-kit-de-medios-oficial-brand)
13. [Resumen de Despliegue en Producción (Coolify & GitHub)](#13-resumen-de-despliegue-en-producción-coolify--github)

---



## 1. Logo Oficial, Identidad Visual y SEO Integral

### Identidad Vectorial y Branding
- **Logo Vectorial Oficial (SVG)**: Se reemplazaron imágenes rasterizadas por el isotipo oficial en formato SVG (`/logo.svg`), compuesto por un libro abierto estilizado, la silueta del hogar y su chimenea en color esmeralda institucional (`#0F6E56`).
- **Presencia en la Plataforma**:
  - Navbar superior de la Landing Page y páginas legales.
  - Sidebar de navegación de la aplicación interna (`AppSidebar.astro`) con soporte para avatares y pantallas Retina.
  - Pantalla de inicio de sesión (`LoginScreen.tsx`) con marco limpio y tipografía corporativa.
  - Pie de página institucional y documentos imprimibles de aulas físicas.

### SEO y Optimización para Motores de Búsqueda
- **Metadatos y OpenGraph**:
  - `SiteLayout.astro` configurado con meta description, keywords, autor y URL canónica.
  - Etiquetas OpenGraph completas (`og:title`, `og:description`, `og:image`, `og:url`, `og:site_name`, `og:locale`).
  - Twitter Cards (`summary_large_image`).
- **Microdatos Schema.org**: Integración de datos estructurados en formato **JSON-LD** definiendo `SoftwareApplication` y `EducationalOrganization`.
- **Rastreo e Indexación**: Creación de archivos estáticos `public/robots.txt` y `public/sitemap.xml`.

---

## 2. Modo Impersonación de Super Administrador y Bypass de Guards

### Objetivo
Permitir que el Super Administrador global pueda inspeccionar y operar cualquier institución educativa de la plataforma actuando bajo los roles de **Director**, **Coordinador** o **Docente**, sin perder su sesión ni ser expulsado por los guards de autenticación.

### Cambios Clave
1. **Bypass Absoluto en `useAuthGuard`**:
   - `frontend/src/hooks/useAuthGuard.ts`: Permite el acceso irrestricto si `session.user.role === 'admin'`, evitando redirecciones forzadas a `/login` al navegar vistas docentes o directivas.
   - `authService.ts`: `refreshSession()` preserva la sesión activa sin vaciar el store de sesión si el usuario es `admin`.
2. **Visualización de Cursos en Modo Docente**:
   - `backend/src/services/course.service.ts`: Cuando un admin accede a una institución en modo docente y no tiene materias asociadas a su id nominal, la plataforma lista todos los cursos del establecimiento para permitir supervisión y creación de actividades.
3. **Badge de Identidad Dinámico**:
   - `SessionUserBadge.tsx` muestra la etiqueta contextual: `Admin (como Docente)`, `Admin (como Director)` o `Admin (como Coordinador)`.

---

## 3. Sistema Granular de Roles RBAC y Permisos por Módulo

### Base de Datos y Persistencia
- **Migración `005_custom_roles_and_permissions.sql`**:
  - Tabla `RoleDefinition`: `id` (slug), `name`, `description`, `is_system`, `createdAt`, `updatedAt`.
  - Tabla `RolePermission`: `role_id`, `module`, `can_read`, `can_create`, `can_update`, `can_delete`, `can_export`.
  - Semillas de permisos para roles predefinidos (`admin`, `coordinador`, `director`, `docente`, `auditor`).

### Módulos de Plataforma Soportados (13 Módulos)
`instituciones`, `configuracion`, `usuarios`, `cursos`, `actividades`, `alumnos`, `resultados`, `alertas`, `cumplimiento`, `suscripciones`, `monitoreo`, `jira`, `roles`.

### API REST y Frontend
- Endpoints REST en `backend/src/routes/role.routes.ts` (`GET /api/roles`, `POST /api/roles`, `PATCH /api/roles/:id`, `DELETE /api/roles/:id`).
- Pantalla administrativa `RolesManagementScreen.tsx` en `/admin/roles` con matriz interactiva de permisos y acciones masivas.

---

## 4. Gestión de Planes de Suscripción y Personalización por Negocio

### Base de Datos y Persistencia
- **Migración `006_subscription_plans_and_overrides.sql`**:
  - Tabla `Plan`: `description`, `annualPriceArs`, `maxStudents`, `maxCourses`, `storageGb`, `features` (JSONB con flags modulares), `badge`, `isActive`.
  - Tabla `Subscription`: cupos y módulos sobreescritos por institución (`customMaxUsers`, `customMaxStudents`, `customMaxCourses`, `customStorageGb`, `customFeatures`, `customNotes`, `billingCycle`).

### Centro de Suscripciones (`/admin/suscripciones`)
- Componente `RenewalScreen.tsx` con 3 áreas de gestión:
  1. **Suscripciones por Institución**: Lista de colegios con botón **"Personalizar Negocio"** (ajuste a medida de cupos, almacenamiento y precio convenido para cada cliente escolar).
  2. **Planes de Suscripción**: Alta, modificación y baja de planes comerciales.
  3. **Matriz Comparativa**: Comparador técnico de capacidades entre planes.

---

## 5. Sistema de Aulas Físicas con QR Fijo, Escáner en App y Carga de Lecturas

### Propósito Pedagógico
Permitir que las aulas de clase cuenten con un código QR fijo impreso en el salón (puerta o pared). Al ingresar al aula, la docente escanea el código desde la aplicación de Habitar, conectando su sesión al aula física para subir archivos de lectura o asignar diagnósticos en los tres ejes cognitivos sin depender de proyectores.

### Base de Datos y Backend
- **Migración `007_course_fixed_qr_and_room.sql`**:
  - Campos agregados a `Course`: `qrCode` (ej: `AULA-6A-781A`), `room` (salón), `grade` (año/grado), `division` (sección), `shift` (turno mañana/tarde/noche), `activeActivityId`.
  - Backfill determinista para aulas previas.
- Endpoints en `course.routes.ts`:
  - `POST /api/courses` (creación de aula con generación de código QR).
  - `GET /api/courses/by-qr/:qrCode` (resolución instantánea del aula física al escanear).

### Componentes en el Frontend
1. **`QrScannerModal.tsx`**:
   - Escáner en tiempo real mediante `navigator.mediaDevices.getUserMedia` y `BarcodeDetector`.
   - Selector de cámara frontal/trasera y fallback por canvas.
   - Pestaña de entrada manual (`AULA-...`) y subida de fotografía del código QR.
2. **`CourseQrModal.tsx`**:
   - Visualización del código QR vectorial con botón **"Imprimir Cartel de Aula"** (optimizado para hoja A4) y **"Descargar PNG de Alta Resolución"**.
3. **`CreateCourseModal.tsx`**:
   - Formulario de alta rápida de salones con especificación de grado, división, salón, turno y docente a cargo.
4. **Integración en `TeacherDashboard.tsx` y Asignación de Archivos**:
   - Banner de confirmación cuando el aula física está conectada.
   - Paso 1 del asistente (`NewActivityStep1.tsx`): carga directa de lecturas (`.txt`, `.md`, texto plano y Google Drive) vinculadas al aula física detectada.

---

## 6. Landing Page Institucional y Vinculación Dinámica de Precios

### Características Principales
- **Ruta Principal (`/`)**: Se reconfiguró Astro para servir directamente la Landing Page en la raíz sin requerir ningún slug ni redirecciones forzadas (`start_url: '/'`).
- **Precios Vinculados a la Base de Datos**:
  - Endpoint público en backend: `GET /api/subscriptions/plans/public`.
  - Consumo en frontend mediante `subscriptionService.ts` con fallback estático inmediato (`DEFAULT_PUBLIC_PLANS`).
  - Selector interactivo entre **Facturación Mensual** y **Facturación Anual** (con descuento bonificado de 2 meses).
  - Exhibición de ofertas: **Piloto Gratuito (60 días / $0)**, **Plan Estándar** y **Premium Institucional**.
- **Contenido y Navegación**:
  - Navbar con logo SVG oficial, menú hamburguesa 100% responsivo para celulares y anclas a secciones.
  - Presentación de los **3 Ejes Cognitivos** (Literal, Inferencial y Crítico) con preguntas interactivas de muestra generadas por IA.
  - Demostración visual de aulas QR y analítica institucional.
  - Preguntas frecuentes (FAQ) en formato acordeón.
- **Experiencia de Usuarios Autenticados**:
  - Si un usuario ya logueado navega por la landing, visualiza en el navbar su avatar, nombre, rol y el botón directo *"Ir a mi Panel"*, manteniéndose la landing visible e interactiva.

---

## 7. Privacidad, Gobernanza de Datos y Normativa Educativa de la Provincia de Buenos Aires (DGCyE)

### Marco Normativo Contemplado
- **Ley de Educación Provincial N° 13.688 (PBA)**:
  - **Artículo 16**: Protección integral de la intimidad, dignidad y derechos de los educandos.
- **Pautas de Entornos Digitales Seguros (DGCyE & DIPREGEP)**:
  - **Supervisión Docente Continua**: Prohibición estricta de delegar decisiones disciplinarias o de acreditación académica en algoritmos automatizados. La IA en Habitar es puramente asistiva.
  - **Sin Re-entrenamiento de Modelos**: Las respuestas y textos de los estudiantes nunca se utilizan para entrenar LLMs públicos ni comerciales.
  - **Cero Monetización / Cero Publicidad**: Prohibición de explotación comercial o perfilamiento publicitario sobre menores.
- **Ley Nacional N° 25.326 de Protección de Datos Personales**:
  - **Modelo B2B**: La Escuela actúa como *Responsable del Tratamiento* (Data Controller); Habitar como *Encargado del Tratamiento* (Data Processor).
  - **Derechos ARCO Nativos**: Acceso, Rectificación, Cancelación y Oposición garantizados con trazabilidad inmutable.
- **Ley Nacional N° 26.061**: Principio del Interés Superior del Niño.

### Implementación en la Plataforma
1. **Sección de Privacidad en Landing (`/#privacidad`)**:
   - Cuatro pilares de cumplimiento (Marco DGCyE PBA, Gobernanza B2B, IA Ética y Derechos ARCO / Cifrado TLS 1.3 / AES-256).
2. **Página Oficial de Privacidad (`/privacidad`)**:
   - Creada en `src/pages/privacidad.astro` y `PrivacyPolicyScreen.tsx` con 7 cláusulas institucionales y canal del Oficial de Privacidad (`privacidad@habitar.lat`).
   - Sección con ancla directa `/privacidad#derechos-arco` para consultas sobre derechos de los titulares.

---

## 8. Acceso 100% Público a la Privacidad y Consentimiento Escolar

### Desacople de Autenticación
Dado que los usuarios generales, familias o directivos prospecto no disponen de cuenta escolar hasta registrarse formalmente, se eliminó cualquier barrera de autenticación para consultar los términos de privacidad y gobernanza:

1. **Pantalla de Consentimiento Escolar (`/consentimiento`)**:
   - Se removió el guard de autenticación (`useAuthGuard`).
   - Acceso público a las cláusulas de consentimiento institucional y roles de tratamiento.
   - **Herramienta para Colegios**: Botón **"Copiar Texto para Cuaderno"** con un modelo formal listo para enviar a familias y tutores legales informando la adhesión a Habitar.
   - Botón para imprimir el pliego en hoja A4.
   - **Firma Digital Condicional**: Si quien ingresa es un directivo o coordinador autenticado, se habilita la casilla de firma y auditoría para registrar la aceptación en nombre de su colegio.
2. **Enlaces Públicos en el Pie de Página**:
   - El enlace de Derechos ARCO redirige a `/privacidad#derechos-arco` (público) en lugar de rutas internas que exigían login.
   - Acceso público a `/status` (monitoreo SLA del servicio).

---

## 9. Asignación y Delegación de Aulas a Docentes por Directores y Coordinadores

### Objetivo
Permitir que el Director o Coordinador escolar asigne formalmente a cada docente las aulas físicas y cursos específicos en los cuales debe trabajar, asegurando que cada educador vea únicamente sus espacios asignados al iniciar sesión.

### Base de Datos y Persistencia
- **Migración `008_course_teacher_assignments.sql`**:
  - Creación de la tabla `CourseTeacher`:
    ```sql
    CREATE TABLE IF NOT EXISTS "CourseTeacher" (
        "id" TEXT NOT NULL PRIMARY KEY DEFAULT gen_random_uuid()::text,
        "courseId" TEXT NOT NULL,
        "teacherId" TEXT NOT NULL,
        "roleInCourse" TEXT NOT NULL DEFAULT 'TITULAR',
        "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "CourseTeacher_courseId_teacherId_key" UNIQUE ("courseId", "teacherId"),
        CONSTRAINT "CourseTeacher_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE,
        CONSTRAINT "CourseTeacher_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "User"("id") ON DELETE CASCADE
    );
    ```
  - Backfill automático de los cursos existentes para poblar `CourseTeacher`.
- **CourseRepository (`backend/src/repositories/course.repository.ts`)**:
  - `findByTeacher`: consulta aulas donde el docente es titular (`teacherId`) o figura en `CourseTeacher`.
  - `assignTeacher`: asigna un docente a un curso específico y sincroniza ambas tablas.
  - `setTeacherCourses`: desvincula cursos previos y asocia masivamente la lista exacta de aulas seleccionadas para ese docente.

### Endpoints REST y Roles
- `PATCH /api/courses/:id/teacher`: Reasignar docente de un aula individual.
- `PUT /api/courses/teachers/:teacherId/assignments`: Asignar masivamente aulas a un docente.
- `GET /api/courses/teachers/:teacherId/assignments`: Obtener las aulas asignadas al docente.
- Soporte para rol `DIRECTOR` con plenas facultades en `requireRole('COORDINADOR', 'DIRECTOR', 'ADMIN')`.

### Interfaz de Gestión en Frontend
1. **Configuración Institucional (`/institucional/configuracion`)**:
   - En la tabla de usuarios, cada docente presenta la columna **"Aulas de Trabajo"** con badges de sus aulas actuales o *"Sin aulas"*.
   - Botón **"Asignar Aulas"** que abre el modal interactivo **`AssignTeacherCoursesModal.tsx`**:
     - Listado completo de aulas de la escuela con checkboxes.
     - Buscador en tiempo real por materia, grado, salón o turno.
     - Acciones rápidas *"Seleccionar Todas"* y *"Deseleccionar"*.
     - Alerta si un aula ya estaba asignada a otro educador.
     - Guardado persistente inmediato.
2. **Dashboard Institucional (`/institucional`)**:
   - En la tabla de rendimiento, el Director puede hacer clic en el botón de edición junto al docente a cargo para abrir **`ReassignCourseTeacherModal.tsx`** y reasignar el aula a cualquier docente activo de la escuela.
3. **Creación de Nuevas Aulas (`CreateCourseModal.tsx`)**:
   - Se incorporó el campo selector *"Docente Asignado/a a Cargo"* para asignar la nueva aula desde el momento de su creación.
4. **Experiencia del Docente (`/docente/cursos`)**:
   - Al ingresar a la plataforma, el docente visualiza con exactitud las aulas físicas que le delegó el equipo directivo.

---

## 10. Conexión con Resend para Envíos de Notificaciones e Invitaciones Institucionales

### Objetivo
Integrar el motor de correo transaccional **Resend** en el backend de Habitar para automatizar el despacho de correos electrónicos institucionales cuando se invita o vincula a un docente, director, coordinador o administrador con una institución educativa específica.

### Aspectos Implementados
1. **SDK e Infraestructura de Correo (`resend`)**:
   - Incorporación de la librería oficial `resend` en el backend (`backend/package.json`).
   - Configuración centralizada y tipada en `backend/src/config/env.ts` con variables `RESEND_API_KEY` y `RESEND_FROM_EMAIL`.
   - Documentación y ejemplos en `backend/.env.example` con remitente por defecto `Habitar <onboarding@resend.dev>`.
2. **Servicio Transaccional Especializado (`email.service.ts`)**:
   - `sendInvitationEmail()`: Genera y despacha correos con maquetación HTML responsive, paleta esmeralda (`#0F6E56`), badges de rol y estructura visual corporativa.
   - **Plantilla para Docentes (`DOCENTE`)**:
     - Notifica que su correo fue vinculado a la institución educativa (indicando el nombre exacto del establecimiento).
     - Detalla las herramientas docentes disponibles: aulas asignadas, generación de QR para alumnos en pantalla/proyector, creación y evaluación de actividades en ejes literal, inferencial y crítico, y métricas grupales protegidas.
     - Botón de acceso directo: *"Ingresar a Habitar"*.
   - **Plantilla para Administradores, Directores y Coordinadores (`ADMIN`, `DIRECTOR`, `COORDINADOR`)**:
     - Notifica que se le han concedido permisos de gestión institucional en la escuela correspondiente.
     - Detalla las facultades administrativas: gestión y alta de divisiones/aulas, asignación de docentes a cursos, configuración de niveles educativos (Primaria/Secundaria) y ejes de comprensión, y control de cuotas de IA.
     - Botón de acceso directo: *"Acceder a la Consola de Gestión"*.
   - `sendRoleUpdatedEmail()`: Notificación inmediata cuando el rol de un usuario es actualizado o promovido en la institución.
3. **Resiliencia y Modo Simulación (Zero-Crash Guarantee)**:
   - Si `RESEND_API_KEY` no se encuentra configurada (entornos locales o pruebas sin credenciales), el servicio simula el envío en consola sin arrojar error ni interrumpir la creación o invitación del usuario.
   - Los envíos se ejecutan de manera no bloqueante en `user.service.ts` (`inviteUser` y `updateRole`), garantizando que cualquier contingencia externa de red o de cuotas en Resend nunca aborte la transacción en la base de datos.

---

## 11. Soporte Multimodelo de IA (DeepSeek y OpenAI) y Gestión de Claves por Institución (BYOK)

### Objetivo
Permitir que los administradores, directores y coordinadores de cada institución educativa seleccionen el motor de Inteligencia Artificial que mejor se adapta a su proyecto pedagógico (**DeepSeek** o **OpenAI / ChatGPT**), eligiendo libremente entre utilizar la clave central de la plataforma (sujeta a la cuota del plan escolar) o conectar su **propia clave de API (BYOK - Bring Your Own Key)**.

### Aspectos Implementados
1. **Migración de Base de Datos `009_institution_ai_config.sql`**:
   - Se agregaron campos a la tabla `Institution`:
     - `aiProvider`: `'DEEPSEEK'` o `'OPENAI'` (por defecto `'DEEPSEEK'`).
     - `aiKeySource`: `'PLATFORM'` (clave del servidor) o `'CUSTOM'` (clave propia de la escuela).
     - `aiCustomApiKey`: Almacenamiento seguro de la API Key propia.
     - `aiModel`: Modelo específico asignado (ej: `deepseek-chat`, `deepseek-reasoner`, `gpt-4o-mini`, `gpt-4o`, `gpt-3.5-turbo`).
2. **Servicio Unificado de Generación Pedagógica (`ai-question-generator.service.ts`)**:
   - Soporte nativo compatible con las especificaciones de OpenAI y DeepSeek para el diseño de 5 preguntas pedagógicas estructuradas (1 literal, 3 inferenciales, 1 crítica).
   - Método `testConnection()`: Permite realizar un ping de prueba en tiempo real para verificar la validez de las credenciales y el modelo antes o después de guardar.
   - Endpoint seguro en API REST: `POST /api/institutions/:institutionId/ai-config/test`.
3. **Resolución Dinámica en Actividades (`activity.service.ts`)**:
   - Al generar preguntas a partir de un texto fuente cargado por el docente, el sistema lee la configuración de la institución educativa.
   - Si la institución opera en modo **BYOK (Clave Propia)**, las solicitudes no consumen la cuota mensual del plan escolar de Habitar.
   - Resiliencia garantizada: Si la API remota experimenta demoras o la clave no tiene saldo, se activa automáticamente el generador pedagógico por plantillas (mock asistivo), registrando la auditoría correspondiente sin interrumpir la clase del docente.
4. **Seguridad y Enmascaramiento**:
   - Las claves privadas nunca se devuelven en texto plano al frontend. La API expone `aiCustomApiKeyMasked` (ej: `sk-••••••••4a8b`) y `hasCustomApiKey: true`.
5. **Panel de Configuración Institucional en Frontend (`InstitutionSettingsScreen.tsx`)**:
   - Tarjeta dedicada **"Inteligencia Artificial y Modelos Pedagógicos"**:
     - Selector visual interactivo entre DeepSeek y OpenAI (ChatGPT).
     - Selector de origen de clave (Clave Central de Habitar vs Clave Propia de la Institución).
     - Campo de entrada protegido con toggle mostrar/ocultar y visualización de la clave activa actual.
     - Selector de modelo pedagógico adaptativo según el proveedor seleccionado.
     - Botón **"Probar conexión con la IA"** con feedback visual instantáneo (badge de éxito con modelo utilizado o alerta con el mensaje devuelto por el proveedor).
     - Guardado persistente inmediato.

---

## 12. Página Pública de Marca, Identidad y Kit de Medios Oficial (`/brand`)

### Objetivo
Proveer a la comunidad educativa, diseñadores, directivos, prensa y colaboradores escolares de un centro oficial de recursos de marca (`/brand`), con acceso sin restricciones a los fundamentos visuales de Habitar, su tono de voz institucional, paleta cromática interactiva con copia de códigos HEX/RGB y descargas directas de logotipos vectoriales en formato SVG y PNG de alta resolución.

### Aspectos Implementados
1. **Ruta y Componente Especializado (`/brand` & `BrandScreen.tsx`)**:
   - Página estática de carga ultra-rápida servida en Astro (`src/pages/brand.astro`) con layout canónico y SEO dedicado.
   - Componente interactivo React `BrandScreen.tsx` con sistema de notificaciones toast y utilidades de exportación en tiempo real.
2. **Galería Vectorial con 4 Variantes Oficiales**:
   - **Isotipo Oficial (Color)**: Símbolo del libro abierto y casa con chimenea en verde esmeralda `#0F6E56` sobre fondo claro.
   - **Logotipo Horizontal Completo (Color)**: Isotipo + tipografía "Habitar" + bajada "COMPRENSIÓN LECTORA" para cabeceras y papelería institucional.
   - **Isotipo Invertido (Blanco)**: Sobre fondo esmeralda institucional para fondos oscuros y cartelería escolar nocturna.
   - **Logotipo Horizontal Invertido**: Versión monocromática blanca sobre `#064E3B` para presentaciones y pie de página.
   - **Herramientas de Exportación para Cada Variante**:
     - Botón *"Descargar SVG"* (vectorial nativo sin pérdida de calidad).
     - Botón *"PNG Alta Resolución"* (generado dinámicamente mediante HTML Canvas en 1024x1024 o 1920x480).
     - Botón *"Copiar código SVG"* para pegar directamente en Figma, Illustrator o código fuente.
3. **Muestra Cromática con Copia Rápida**:
   - Swatches interactivos con valores HEX y RGB para los colores oficiales:
     - Esmeralda Habitar Primario (`#0F6E56`)
     - Verde Bosque Profundo (`#064E3B`)
     - Menta Suave (`#E0EFEA`)
     - Superficie Institucional (`#F8FBF9`)
     - Gris Oscuro de Lectura (`#111827`)
     - Colores de los Ejes Cognitivos: Literal (`#0F6E56`), Inferencial (`#2563EB`), Crítico (`#D97706`).
   - Clic en cualquier muestra para copiar su código HEX al portapapeles.
4. **Tipografía y Estilo de Texto**:
   - Muestra interactiva de jerarquías: Display (36px), Titular H1 (24px), Cuerpo (15px) y Código/Aula QR (13px Monospace).
   - Botón para copiar la regla CSS de tipografía institucional (`Inter`, `-apple-system`, `sans-serif`).
5. **Guía de Tono de Voz y Comunicación**:
   - Pilares de comunicación: *Riguroso pero Accesible*, *Calidez Rioplatense* (voseo respetuoso) y *Ética y Transparencia*.
6. **Normas de Uso (Do's & Don'ts)**:
   - Especificaciones de espacio de reserva perimetral, tamaños mínimos en pantalla y restricciones de no distorsión ni alteración de colores.
7. **Textos Institucionales para Medios (Boilerplates)**:
   - Descripciones oficiales en versión corta (1 línea), mediana (1 párrafo para prensa) y extendida (para convenios y pliegos educativos) con botones de copiado rápido con un solo clic.
8. **Indexación y Enlaces**:
   - Agregado en el pie de página de la Landing Page (`LandingPage.tsx`).
   - Declarado en `public/sitemap.xml` para indexación en motores de búsqueda.

---

## 13. Resumen de Despliegue en Producción (Coolify & GitHub)

| Repositorio | Últimos Commits | Funcionalidad Principal |
| :--- | :--- | :--- |
| **Frontend** | `81b17b5` | Página pública `/brand` con manual de identidad, tono de voz y descargas de logotipos SVG y PNG |
| **Backend** | `1ddda3f` | Soporte multimodelo DeepSeek y OpenAI con claves de plataforma o BYOK por institución, migración 009 |
| **Frontend** | `cfb2b14` | Interfaz de selección de proveedor DeepSeek/OpenAI, BYOK y prueba de conexión en configuración institucional |
| **Backend** | `be7c367` | Integración con Resend para invitaciones por email a docentes y directivos (`email.service.ts`, `env.ts`) |
| **Backend** | `18fa6cd` | Asignación de aulas a docentes, migración 008 `CourseTeacher`, rol DIRECTOR y endpoints de asignación |
| **Frontend** | `6411e7e` | Modales de asignación de aulas (`AssignTeacherCoursesModal`, `ReassignCourseTeacherModal`), selector al crear curso |
| **Frontend** | `1d5e8c0` | Acceso 100% público a privacidad, consentimiento escolar y derechos ARCO sin login |
| **Frontend** | `fb926a5` | Página y sección de Privacidad PBA (DGCyE / Ley 13.688 / Ley 25.326 / Ley 26.061) |
| **Frontend** | `b647695` | Logo oficial SVG, navbar responsivo con menú móvil y badge de usuario autenticado |
| **Backend** | `d86e62b` | Endpoint público de planes de suscripción para la Landing Page |
