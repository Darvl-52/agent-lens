# Какие дыры проходит шаг правил безопасности и почему

Заметка к шагу `security` в `/setup-project`: откуда взят список классов атак в `hooks/setup/words.ts`.
Минимум правил там же, разбитый на фронтенд и бэкенд, составлен по этому списку.
Источники проверены 2026-10-31. Это короткая выжимка из первоисточников, а не полный обзор: разбор
каждого класса с примерами кода не делался.

## Что говорят первоисточники

**[OWASP Top 10:2025](https://top10.owasp.org/2025)**: A01 Broken Access Control, A02 Security
Misconfiguration, A03 Software Supply Chain Failures, A04 Cryptographic Failures, A05 Injection, A06
Insecure Design, A07 Authentication Failures, A08 Software or Data Integrity Failures, A09 Security
Logging and Alerting Failures, A10 Mishandling of Exceptional Conditions.

**[CWE Top 25, 2025](https://cwe.mitre.org/top25/archive/2025/2025_cwe_top25.html)**. Первые четыре
места: XSS (CWE-79), SQL-инъекция (CWE-89), CSRF (CWE-352), отсутствие авторизации (CWE-862). Для
веб-кода важны также path traversal (CWE-22), OS command injection (CWE-78), code injection (CWE-94),
небезопасная загрузка файлов (CWE-434), десериализация (CWE-502), раскрытие данных (CWE-200), нет
аутентификации у критичной функции (CWE-306), SSRF (CWE-918), авторизация по ключу от клиента, то есть
IDOR (CWE-639), и нет лимитов на ресурсы (CWE-770). Ошибки памяти из этого списка в шаг не вошли.

**[Veracode, GenAI Code Security Report, 2025](https://www.veracode.com/press-release/ai-generated-code-poses-major-security-risks-in-nearly-half-of-all-development-tasks-veracode-research-reveals/)**.
Больше 100 моделей, 80 задач: уязвимость появилась в 45% случаев. Хуже всего с XSS (CWE-80, провал в
86%) и log injection (CWE-117, провал в 88%). Поэтому эти два класса стоят первыми в списке шага,
хотя log injection нет ни в первой десятке OWASP, ни в CWE Top 25.

## Что не подтверждено

- Правила минимума для фронтенда и бэкенда написаны по этим классам и общей практике; построчно с
  первоисточниками и документацией фреймворков они не сверялись. Вид про функции с LLM в этих источниках
  не разбирался.
- Страница OWASP не называет версию ни финальной, ни кандидатом в релиз; сторонние публикации называют
  список финальным.
- Более свежие цифры Veracode за 2026 год (XSS около 15% успеха, log injection около 13%) найдены только
  во вторичных обзорах. Здесь они не используются.
