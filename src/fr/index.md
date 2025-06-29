---
title: 'Page en français'
description: "Ceci est la version française de la page d'accueil"
---

<h2>Articles de blog</h2>
<ul>
  {%- for post in collections.blog_fr | reverse -%}
    <li><a href="{{ post.url }}">{{ post.data.title }}</a></li>
  {%- endfor -%}
</ul>
