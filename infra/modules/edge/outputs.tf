output "alb_dns_name" {
  description = "Point the API hostname (CNAME / alias) here."
  value       = aws_lb.this.dns_name
}

output "alb_zone_id" {
  value = aws_lb.this.zone_id
}

output "alb_arn_suffix" {
  value = aws_lb.this.arn_suffix
}

output "target_group_arn" {
  value = aws_lb_target_group.api.arn
}

output "target_group_arn_suffix" {
  value = aws_lb_target_group.api.arn_suffix
}

output "web_acl_name" {
  value = aws_wafv2_web_acl.this.name
}
