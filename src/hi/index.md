---
title: 'हिंदी पृष्ठ'
description: 'यह मुखपृष्ठ का हिंदी संस्करण है'
---

<h2>ब्लॉग पोस्ट</h2>
<ul>
  {%- for post in collections.blog_hi | reverse -%}
    <li><a href="{{ post.url | url }}">{{ post.data.title }}</a></li>
  {%- endfor -%}
</ul>
