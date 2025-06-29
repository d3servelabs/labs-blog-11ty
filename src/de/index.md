---
title: 'Deutsche Seite'
description: 'Dies ist die deutsche Version der Startseite'
---

Dies ist ein minimaler Starter für lokalisierte Inhalte mit [Eleventy](https://www.11ty.dev/).

Er verwendet Eleventys eigenes [Internationalization (I18n) Plugin](https://www.11ty.dev/docs/plugins/i18n/), das mit [Eleventy](https://www.11ty.dev/) ab Version 2.0 gebündelt ist.

In einem [Artikel auf meiner Website](https://www.lenesaile.com/de/blog/internationalisierung-mit-eleventy-20-und-netlify/) erkläre ich den Aufbau des _Starters_ und alle getroffenen Entscheidungen nochmal genau.

<h2>Blogbeiträge</h2>
<ul>
  {%- for post in collections.blog_de | reverse -%}
    <li><a href="{{ post.url | url }}">{{ post.data.title }}</a></li>
  {%- endfor -%}
</ul>
