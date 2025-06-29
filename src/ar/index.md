---
title: 'الصفحة العربية'
description: 'هذه هي النسخة العربية من الصفحة الرئيسية'
---

<h2>مقالات المدونة</h2>
<ul>
  {%- for post in collections.blog_ar | reverse -%}
    <li><a href="{{ post.url }}">{{ post.data.title }}</a></li>
  {%- endfor -%}
</ul>
