# WordPress plugin

`sdks/shravelle-sdk-wordpress/shravelle`. Zip the folder and upload it under Plugins → Add New → Upload, or copy it to
`wp-content/plugins/`, then activate **Shravelle Monitoring**.

**Settings → Shravelle:** ingest endpoint, browser key, ingest key, slow-request threshold (ms), exclude
wp-admin.

What it sends:
- **Real user monitoring** on every front-end page (the browser SDK is bundled with the plugin, so there are no
  external script requests): page loads, Core Web Vitals, JS errors, AJAX.
- **PHP errors and warnings** (error handler) and **fatal errors** (shutdown handler) as logs → Errors Inbox.
- **Slow requests** above the threshold as WARN logs with URL and duration.
- **Deployment markers** when plugins, themes or core are updated.

Data is sent after the response is flushed (`fastcgi_finish_request`), so visitors never wait for it.
For full PHP tracing (DB queries, hooks), add the [PHP SDK or OTel extension](https://shravelle.com/docs.html#php).


---
Part of [Shravelle](https://shravelle.com). Setup guide for every platform: [shravelle.com/docs](https://shravelle.com/docs.html) · Get your keys: [shravelle.com/get-started](https://shravelle.com/get-started.html)
