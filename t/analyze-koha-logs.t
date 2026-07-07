#!/usr/bin/perl

# Tests for bin/analyze-koha-logs.pl against a hand-computed fixture log.
#
# Fixture contents (t/fixtures/sample-access.log), all 29 Jun 2026, -0400:
#   Session A (10.0.0.1 Firefox): opac-main 09:00:00, search "harry potter"
#     09:00:10, detail 09:00:25, search offset=20 (pagination) 09:00:45.
#     Plus two static asset requests (excluded from session/page stats).
#     Think gaps: 10, 15, 20.
#   Bot (Googlebot): one detail + one search, both excluded.
#   Session C (10.0.0.2 Chrome): search "été" 09:10:00, search
#     "harry potter" 09:10:30. Think gap: 30.
#   One garbage line (counted as skipped).
#   Session B (10.0.0.1 Firefox again, 34 min after A - past the 1800s
#     timeout): opac-main 09:35:00, search "dog man" 09:35:05, detail
#     09:35:13. Think gaps: 5, 8.
#
# Expected (window 09:00-10:00, 3600s): 11 non-bot requests, 9 pages,
# 4 searches, 1 pagination, 3 sessions, CTR 2/3, details/search 2/4,
# think gaps sorted [5,8,10,15,20,30].

use strict;
use warnings;
use utf8;
use Test::More;
use File::Temp qw(tempdir);
use File::Basename qw(dirname);
use File::Spec;
use JSON::PP;
use IO::Compress::Gzip qw(gzip $GzipError);

my $script  = File::Spec->catfile( dirname(__FILE__), '..', 'bin', 'analyze-koha-logs.pl' );
my $fixture = File::Spec->catfile( dirname(__FILE__), 'fixtures',  'sample-access.log' );
my $dir     = tempdir( CLEANUP => 1 );
my $json    = JSON::PP->new->utf8;

my $n = 0;

sub run_analyzer {
    my (@args) = @_;
    $n++;
    my $out = File::Spec->catfile( $dir, "cal-$n.json" );
    my $cmd = join ' ', map {"'$_'"} ( $^X, $script, '--out', $out, @args );
    my $rc = system("$cmd 2>/dev/null");
    die "analyzer exited non-zero: $rc" if $rc != 0;
    open my $fh, '<', $out or die "no output: $!";
    local $/;
    return $json->decode(<$fh>);
}

my @window = ( '--from', '2026-06-29 09:00', '--to', '2026-06-29 10:00' );
my $terms_file = File::Spec->catfile( $dir, 'terms.json' );

my $cal = run_analyzer( @window, '--terms', $terms_file, '--min-term-count', 1, $fixture );

subtest 'meta counts' => sub {
    plan tests => 5;
    is( $cal->{meta}{lines_total},      14,   'lines_total' );
    is( $cal->{meta}{lines_parsed},     13,   'lines_parsed' );
    is( $cal->{meta}{lines_skipped},    1,    'garbage line skipped' );
    is( $cal->{meta}{bot_requests_pct}, 15.4, 'bot percentage' );
    ok( $cal->{meta}{has_response_times}, 'response times detected' );
};

subtest 'arrival rates' => sub {
    plan tests => 6;
    is( $cal->{arrival}{searches_per_hour}, 4,      'searches_per_hour' );
    is( $cal->{arrival}{sessions_per_hour}, 3,      'sessions_per_hour' );
    is( $cal->{arrival}{req_per_sec},       0.0031, 'req_per_sec includes static' );
    is( $cal->{arrival}{page_req_per_sec},  0.0025, 'page_req_per_sec excludes static' );
    is( $cal->{arrival}{searches_per_sec},  0.0011, 'searches_per_sec' );
    is_deeply(
        $cal->{arrival}{per_minute},
        [
            { m => '2026-06-29 09:00', req => 6, pages => 4, searches => 1, sessions_started => 1 },
            { m => '2026-06-29 09:10', req => 2, pages => 2, searches => 2, sessions_started => 1 },
            { m => '2026-06-29 09:35', req => 3, pages => 3, searches => 1, sessions_started => 1 },
        ],
        'per-minute curve (bot-only minutes absent)'
    );
};

subtest 'endpoint mix' => sub {
    plan tests => 6;
    my %ep = map { $_->{path} => $_ } @{ $cal->{endpoints} };
    is( $ep{'opac-search.pl'}{count}, 5, 'opac-search.pl count (4 searches + 1 pagination)' );
    is( $ep{'opac-detail.pl'}{count}, 2, 'opac-detail.pl count' );
    is( $ep{'opac-main.pl'}{count},   2, 'opac-main.pl count' );
    is( $ep{'opac-search.pl'}{pct},    55.6, 'search pct of page requests' );
    is( $ep{'opac-search.pl'}{p50_ms}, 250,  'p50 in ms (auto-detected microseconds)' );
    is( $ep{'opac-search.pl'}{p95_ms}, 250,  'p95 in ms' );
};

subtest 'session stats' => sub {
    plan tests => 8;
    my $s = $cal->{sessions};
    is( $s->{count},                   3,     'three sessions (timeout split 10.0.0.1)' );
    is( $s->{click_through_rate},      0.667, 'CTR 2 of 3 search sessions clicked' );
    is( $s->{detail_views_per_search}, 0.5,   '2 details after search / 4 searches' );
    is( $s->{paging_rate},             0.25,  '1 pagination / 4 searches' );
    is( $s->{think_time_s}{mean},      14.7,  'mean think time' );
    is_deeply(
        $s->{think_time_s}{quantiles},
        [ 5, 8, 8, 10, 10, 15, 15, 20, 20, 30, 30 ],
        'think-time quantiles p0..p100 (nearest rank)'
    );
    is_deeply(
        $s->{pages_per_session},
        { mean => 3, p50 => 3, p90 => 4, p99 => 4 },
        'pages per session'
    );
    is_deeply(
        $s->{searches_per_session},
        { mean => 1.3, p50 => 1, p90 => 2 },
        'searches per session'
    );
};

subtest 'weighted terms file' => sub {
    plan tests => 4;
    open my $fh, '<', $terms_file or die "no terms file: $!";
    local $/;
    my $terms = $json->decode(<$fh>);
    is( $terms->{total_weight}, 4, 'total weight' );
    is( scalar @{ $terms->{terms} }, 3, 'three distinct terms (bot search excluded)' );
    is_deeply( $terms->{terms}[0], { t => 'harry potter', w => 2 }, 'top term with weight' );
    ok( ( grep { $_->{t} eq 'été' } @{ $terms->{terms} } ), 'UTF-8 term decoded' );
};

subtest 'gzip input produces identical results' => sub {
    plan tests => 1;
    my $gz = File::Spec->catfile( $dir, 'sample.log.gz' );
    gzip( $fixture => $gz ) or die "gzip failed: $GzipError";
    my $cal_gz = run_analyzer( @window, $gz );
    is_deeply( strip_meta($cal_gz), strip_meta($cal), 'same JSON as plain-text input' );
};

subtest 'vhost_combined input produces identical results' => sub {
    plan tests => 1;
    my $vhost = File::Spec->catfile( $dir, 'vhost.log' );
    open my $in,  '<', $fixture or die $!;
    open my $out, '>', $vhost   or die $!;
    print {$out} "opac.example.org:443 $_" for <$in>;
    close $in;
    close $out;
    my $cal_vhost = run_analyzer( @window, $vhost );
    is_deeply( strip_meta($cal_vhost), strip_meta($cal), 'same JSON as combined input' );
};

subtest 'log without %D response times' => sub {
    plan tests => 2;
    my $nord = File::Spec->catfile( $dir, 'no-rt.log' );
    open my $in,  '<', $fixture or die $!;
    open my $out, '>', $nord    or die $!;
    while (<$in>) { s/ \d+$//; print {$out} $_ }
    close $in;
    close $out;
    my $cal_nord = run_analyzer( @window, $nord );
    ok( !$cal_nord->{meta}{has_response_times}, 'has_response_times false' );
    my %ep = map { $_->{path} => $_ } @{ $cal_nord->{endpoints} };
    is( $ep{'opac-search.pl'}{p50_ms}, undef, 'latency percentiles null' );
};

subtest '--compare runs cleanly' => sub {
    plan tests => 1;
    my $self_cal = File::Spec->catfile( $dir, 'cal-1.json' );
    my $cmd      = join ' ', map {"'$_'"} ( $^X, $script, '--out', '-', '--compare', $self_cal, @window, $fixture );
    my $rc       = system("$cmd >/dev/null 2>&1");
    is( $rc, 0, 'exit 0 when comparing against own output' );
};

sub strip_meta {
    my ($cal) = @_;
    my %copy = %$cal;
    delete $copy{meta};
    return \%copy;
}

done_testing();
