# Meetily desktop connector

The adjacent patch adds a ClientRecord settings tab and automatic meeting delivery to the MIT-licensed Meetily Community desktop application.

Apply it to Meetily commit `a2cb62e827da7ef59f65064c97233efb2313878e` or a compatible later checkout:

```bash
git am 0001-Add-ClientRecord-CRM-meeting-delivery.patch
```

The connector sends only the meeting metadata, generated summary, structured fields, attendees, and transcript. It does not send audio.

After building Meetily, open **Settings → ClientRecord**, enter the receiver endpoint and the one-time connector token created in ClientRecord, add the Cloudflare Access service-token values if required, save, and test the connection.
